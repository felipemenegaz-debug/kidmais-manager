import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DbExecutor } from '../db/contracts.ts';
import { revalidarHorarioSelecionado } from '../disponibilidade/services/availability.service.ts';
import { AvailabilityServiceError } from '../disponibilidade/services/errors.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';
import type * as Schema from './comercial-schema.ts';

// comercial-schema importa sem extensão (estilo do app): carregado pelo transpilador dos testes.
const { comercialFechamentoSchema, periodoDoPedido, temPeriodoDoPedido } = carregarModulo('lib/fechamentos/comercial-schema.ts', {}) as unknown as typeof Schema;

/**
 * 2c-1: o pedido identifica o horário configurado pelo configuracaoId (qualquer quantidade de horários, códigos
 * TURNO_1/TURNO_2/HORARIO_n); o legado horarioBase (almoco→TURNO_1, noite→TURNO_2) segue aceito sem o id.
 */
const T1 = '11111111-1111-4111-8111-111111111111';
const H3 = '33333333-3333-4333-8333-333333333333';
const DIA = '2027-03-20';

const config = (id: string, codigo: string, inicio: string, fim: string, ordem: number, tolerancia = 0, passo = 30) => ({
  id, codigo, nome: codigo, horario_inicio_padrao: `${inicio}:00`, horario_fim_padrao: `${fim}:00`,
  tolerancia_inicio_minutos: tolerancia, passo_inicio_minutos: passo, ordem_exibicao: ordem, ativo: true,
});

/** Executor falso: só a configuração da agenda; sem bloqueios, sem ocupações e sem a 062 (consultas globais). */
function banco(configs = [config(T1, 'TURNO_1', '11:00', '15:00', 1), config(H3, 'HORARIO_3', '19:00', '22:00', 3, 15, 15)]) {
  const consultas: string[] = [];
  const db: DbExecutor = {
    async query(text: string) {
      consultas.push(text);
      if (text.includes('to_regprocedure')) return { rows: [{ instalada: false }], rowCount: 1 } as never;
      if (text.includes('FROM configuracao_agenda')) return { rows: configs, rowCount: configs.length } as never;
      return { rows: [], rowCount: 0 } as never;
    },
  } as DbExecutor;
  return { db, consultas };
}

test('periodoDoPedido: configuracaoId tem precedência; sem ele, almoco→TURNO_1 e noite→TURNO_2', () => {
  assert.deepEqual(periodoDoPedido({ configuracaoId: H3 }), { configuracaoId: H3 });
  assert.deepEqual(periodoDoPedido({ configuracaoId: H3, horarioBase: 'almoco' }), { configuracaoId: H3 });
  assert.deepEqual(periodoDoPedido({ horarioBase: 'almoco' }), { codigoPeriodo: 'TURNO_1' });
  assert.deepEqual(periodoDoPedido({ horarioBase: 'noite' }), { codigoPeriodo: 'TURNO_2' });
  assert.equal(temPeriodoDoPedido({}), false);
  assert.equal(temPeriodoDoPedido({ configuracaoId: H3 }), true);
  assert.equal(temPeriodoDoPedido({ horarioBase: 'noite' }), true);
});

test('schema comercial: aceita configuracaoId sem horarioBase, o legado sem id, ajuste genérico; recusa sem nenhum dos dois', () => {
  const base = {
    dataFesta: DIA, ajusteHorario: '0', horarioInicio: '19:00', horarioFim: '22:00', statusDisponibilidade: 'disponivel',
    pacote: 'pocket', convidadosPagantes: 20, buffetDefinicao: 'depois', valorCombinado: '1000,00', formaPagamento: 'pix_avista',
  };
  assert.equal(comercialFechamentoSchema.safeParse({ ...base, configuracaoId: H3 }).success, true);
  assert.equal(comercialFechamentoSchema.safeParse({ ...base, configuracaoId: H3, ajusteHorario: '-15' }).success, true);
  assert.equal(comercialFechamentoSchema.safeParse({ ...base, horarioBase: 'almoco', ajusteHorario: '30' }).success, true, 'legado');
  const sem = comercialFechamentoSchema.safeParse(base);
  assert.equal(sem.success, false);
  assert.deepEqual(sem.error?.issues.map((i) => i.path.join('.')), ['configuracaoId']);
  assert.equal(comercialFechamentoSchema.safeParse({ ...base, configuracaoId: 'nao-uuid' }).success, false);
  assert.equal(comercialFechamentoSchema.safeParse({ ...base, configuracaoId: H3, ajusteHorario: '1h' }).success, false);
  assert.equal(comercialFechamentoSchema.safeParse({ ...base, horarioBase: '' }).success, false, 'horarioBase vazio não é legado válido');
});

test('revalidação por configuracaoId: acha HORARIO_n e candidatos fora de -30/0/30 (tolerância ±15)', async () => {
  const { db } = banco();
  const r = await revalidarHorarioSelecionado({ data: DIA, configuracaoId: H3, inicio: '19:15', fim: '22:15', ajusteMinutos: 15 }, db);
  assert.equal(r.periodo.configuracaoId, H3);
  assert.equal(r.periodo.codigo, 'HORARIO_3');
  assert.deepEqual(r.candidato, { inicio: '19:15', fim: '22:15', ajusteMinutos: 15, status: 'DISPONIVEL' });
  const menos = await revalidarHorarioSelecionado({ data: DIA, configuracaoId: H3, inicio: '18:45', fim: '21:45', ajusteMinutos: -15 }, db);
  assert.equal(menos.candidato.ajusteMinutos, -15);
});

test('revalidação: o configuracaoId vence o código; sem id, o código legado continua valendo', async () => {
  const { db } = banco();
  // Código de outro horário junto com o id: quem decide é o id.
  const porId = await revalidarHorarioSelecionado({ data: DIA, configuracaoId: H3, codigoPeriodo: 'TURNO_1', inicio: '19:00', fim: '22:00', ajusteMinutos: 0 }, db);
  assert.equal(porId.periodo.configuracaoId, H3);
  const legado = await revalidarHorarioSelecionado({ data: DIA, codigoPeriodo: 'TURNO_1', inicio: '11:00', fim: '15:00', ajusteMinutos: 0 }, db);
  assert.equal(legado.periodo.configuracaoId, T1);
});

test('revalidação: id desconhecido = TURNO_NAO_CONFIGURADO; candidato fora da lista = HORARIO_NAO_DISPONIVEL', async () => {
  const { db } = banco();
  await assert.rejects(
    revalidarHorarioSelecionado({ data: DIA, configuracaoId: '99999999-9999-4999-8999-999999999999', inicio: '11:00', fim: '15:00', ajusteMinutos: 0 }, db),
    (e: unknown) => e instanceof AvailabilityServiceError && e.code === 'TURNO_NAO_CONFIGURADO',
  );
  // Sem id e sem código: nenhum período casa (nunca o primeiro por acaso).
  await assert.rejects(
    revalidarHorarioSelecionado({ data: DIA, inicio: '11:00', fim: '15:00', ajusteMinutos: 0 }, db),
    (e: unknown) => e instanceof AvailabilityServiceError && e.code === 'TURNO_NAO_CONFIGURADO',
  );
  await assert.rejects(
    revalidarHorarioSelecionado({ data: DIA, configuracaoId: T1, inicio: '11:30', fim: '15:30', ajusteMinutos: 30 }, db),
    (e: unknown) => e instanceof AvailabilityServiceError && e.code === 'HORARIO_NAO_DISPONIVEL',
    'TURNO_1 com tolerância 0: só o horário padrão',
  );
});
