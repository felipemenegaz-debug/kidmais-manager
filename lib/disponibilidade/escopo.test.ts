import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DbExecutor } from '../db/contracts.ts';
import {
  bloqueioAplica, ESCOPO_GLOBAL, escopoDaEmpresa, escopoDoFechamento, escopoPublico, mesmoRecurso, type EscopoAgenda,
} from './escopo.ts';
import {
  criarBloqueioAgenda, desativarBloqueioAgendaPorId, desativarBloqueiosExatos, existeBloqueioAgendaAtivoExato,
  listarConfiguracoesAgendaAtivas, verificarConflitoAgendaParaConfirmacao,
} from './repositories/disponibilidade.repository.ts';
import { consultarDisponibilidadeData, revalidarHorarioSelecionado } from './services/availability.service.ts';
import { AvailabilityServiceError } from './services/errors.ts';

/**
 * Agenda por empresa e unidade (062) no código, sem banco: o executor falso aplica as MESMAS regras de escopo que as
 * funções SQL da 062 (espelhadas em escopo.ts) para conferir que o código passa o escopo certo e, sem a 062, continua
 * com as consultas globais anteriores. A semântica no banco é coberta por agenda-062.postgres.test.ts.
 */
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const A1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const A2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
const B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const DIA = '2027-03-20';

type Ocupacao = { fechamento_id: string; data: string; horario_inicio: string; horario_fim: string; empresa_id: string | null; estabelecimento_id: string | null };
type Bloqueio = { id: string; data: string; dia_inteiro: boolean; horario_inicio: string | null; horario_fim: string | null; empresa_id: string | null; estabelecimento_id: string | null; ativo: boolean };
type Estado = {
  v062: boolean;
  unidades: Record<string, string[]>;
  empresasAtivas: string[];
  fechamentos: Record<string, EscopoAgenda>;
  ocupacoes: Ocupacao[];
  bloqueios: Bloqueio[];
  sql: Array<{ text: string; values: readonly unknown[] }>;
};

const turno = { id: 'cfg-1', codigo: 'TURNO_1', nome: 'Almoço', horario_inicio_padrao: '11:00:00', horario_fim_padrao: '15:00:00', tolerancia_inicio_minutos: 0, passo_inicio_minutos: 30, ordem_exibicao: 1, ativo: true };
const linhaBloqueio = (b: Bloqueio, v062: boolean) => ({
  id: b.id, data: b.data, dia_inteiro: b.dia_inteiro, horario_inicio: b.horario_inicio, horario_fim: b.horario_fim, motivo: 'm', observacoes: null,
  criado_por_usuario_id: null, ativo: b.ativo, criado_em: 'x', atualizado_em: 'x', ...(v062 ? { empresa_id: b.empresa_id, estabelecimento_id: b.estabelecimento_id } : {}),
});

function banco(parcial: Partial<Estado> = {}): Estado & { db: DbExecutor } {
  const e: Estado = { v062: true, unidades: {}, empresasAtivas: [A, B], fechamentos: {}, ocupacoes: [], bloqueios: [], sql: [], ...parcial };
  const linhas = (rows: unknown[], rowCount = rows.length) => ({ rows, rowCount }) as never;
  const db: DbExecutor = {
    async query(text: string, values: readonly unknown[] = []) {
      e.sql.push({ text, values });
      const v = values as Array<string | null | boolean>;
      if (text.includes("to_regprocedure('public.kidmais062_ocupacoes_escopo")) return linhas([{ instalada: e.v062 }]);
      if (text.includes('FROM public.estabelecimentos')) return linhas((e.unidades[v[0] as string] ?? []).map((id) => ({ id, codigo: id, nome: `Unidade ${id.slice(0, 2)}` })));
      if (text.includes('FROM public.empresas')) return linhas([{ ok: e.empresasAtivas.includes(v[0] as string) }]);
      if (text.includes('FROM public.fechamentos WHERE id')) {
        const f = e.fechamentos[v[0] as string];
        return linhas(f ? [{ empresa_id: f.empresaId, estabelecimento_id: f.estabelecimentoId }] : []);
      }
      if (text.includes('FROM configuracao_agenda')) return linhas([turno]);
      if (text.includes('kidmais062_ocupacoes_escopo') && text.includes('kidmais062_mesmo_recurso($3')) {
        const alvo = { empresaId: v[2] as string | null, estabelecimentoId: v[3] as string | null };
        return linhas(e.ocupacoes.filter((o) => mesmoRecurso(alvo, { empresaId: o.empresa_id, estabelecimentoId: o.estabelecimento_id })));
      }
      if (text.includes('FROM kidmais_ocupacoes_operacionais')) return linhas(e.ocupacoes);
      if (text.includes('INSERT INTO bloqueios_agenda')) {
        const novo: Bloqueio = { id: `b${e.bloqueios.length + 1}`, data: v[0] as string, dia_inteiro: v[1] as boolean, horario_inicio: v[2] as string | null, horario_fim: v[3] as string | null,
          empresa_id: text.includes('empresa_id') ? v[7] as string : null, estabelecimento_id: text.includes('empresa_id') ? v[8] as string | null : null, ativo: true };
        e.bloqueios.push(novo);
        return linhas([linhaBloqueio(novo, e.v062)]);
      }
      if (text.includes('FROM bloqueios_agenda WHERE id=$1 FOR UPDATE')) {
        const b = e.bloqueios.find((x) => x.id === v[0]);
        return linhas(b ? [{ data: b.data, empresa_id: b.empresa_id }] : []);
      }
      if (text.includes('UPDATE bloqueios_agenda')) {
        const alvo = e.bloqueios.filter((b) => b.ativo && (text.includes('id = $1') ? b.id === v[0]
          : b.data === v[0] && b.horario_inicio === v[1] && b.horario_fim === v[2] && (!text.includes('empresa_id = $4') || (b.empresa_id === v[3] && b.estabelecimento_id === v[4]))));
        for (const b of alvo) b.ativo = false;
        return linhas([], alvo.length);
      }
      if (text.includes('FROM bloqueios_agenda')) {
        const temEscopo = text.includes('kidmais062_bloqueio_aplica(empresa_id');
        const [ini, fim] = text.includes('BETWEEN') ? [v[0], v[1]] : [null, null];
        const alvo = temEscopo ? { empresaId: v[text.includes('BETWEEN') ? 2 : 0] as string | null, estabelecimentoId: v[text.includes('BETWEEN') ? 3 : 1] as string | null } : null;
        return linhas(e.bloqueios.filter((b) => b.ativo && (!ini || (b.data >= ini && b.data <= (fim as string)))
          && (!alvo || bloqueioAplica({ empresaId: b.empresa_id, estabelecimentoId: b.estabelecimento_id }, alvo))).map((b) => linhaBloqueio(b, e.v062)));
      }
      if (text.includes('SELECT EXISTS')) return linhas([{ existe: false }]);
      if (text.includes('pg_advisory_xact_lock') || text.includes('SELECT id FROM bloqueios_agenda')) return linhas([]);
      if (text.includes('bloqueio_agenda')) return linhas([{ bloqueio_agenda: false, fechamento_confirmado: false }]);
      throw new Error(`SQL inesperado: ${text.slice(0, 80)}`);
    },
  };
  return Object.assign(e, { db });
}

const ocupacao = (fechamento: string, empresa: string | null, unidade: string | null): Ocupacao =>
  ({ fechamento_id: fechamento, data: DIA, horario_inicio: '11:00:00', horario_fim: '15:00:00', empresa_id: empresa, estabelecimento_id: unidade });
const statusTurno = async (b: ReturnType<typeof banco>, escopo?: EscopoAgenda) =>
  (await consultarDisponibilidadeData(DIA, b.db, undefined, escopo)).periodos[0].horarios[0].status;

test('regras puras espelham a 062: mesmo recurso e alcance de bloqueio (nulo = alcance anterior, conservador)', () => {
  const r = (e: string | null, u: string | null): EscopoAgenda => ({ empresaId: e, estabelecimentoId: u });
  assert.equal(mesmoRecurso(r(A, A1), r(A, A1)), true);
  assert.equal(mesmoRecurso(r(A, A1), r(A, A2)), false, 'unidades diferentes da mesma empresa');
  assert.equal(mesmoRecurso(r(A, A1), r(B, B1)), false, 'empresas diferentes');
  assert.equal(mesmoRecurso(r(A, null), r(A, A2)), true, 'contratação sem unidade alcança todas as unidades da empresa');
  assert.equal(mesmoRecurso(r(null, null), r(B, B1)), true, 'legado sem empresa conflita com todos');
  assert.equal(bloqueioAplica(r(null, null), r(B, B1)), true, 'bloqueio sem dono é global');
  assert.equal(bloqueioAplica(r(A, null), r(A, A2)), true, 'bloqueio da empresa inteira');
  assert.equal(bloqueioAplica(r(A, A1), r(A, A2)), false, 'bloqueio de outra unidade');
  assert.equal(bloqueioAplica(r(A, A1), r(B, B1)), false, 'bloqueio de outra empresa');
});

test('sem a 062 instalada: consultas globais anteriores, escopo ignorado e nada gravado com empresa', async () => {
  const b = banco({ v062: false, ocupacoes: [ocupacao('fB', B, null)] });
  assert.equal(await statusTurno(b, { empresaId: A, estabelecimentoId: A1 }), 'INDISPONIVEL', 'agenda continua global');
  assert.ok(b.sql.some((q) => q.text.includes('FROM kidmais_ocupacoes_operacionais')));
  assert.ok(!b.sql.some((q) => !q.text.includes('to_regprocedure') && /kidmais062_(ocupacoes_escopo|mesmo_recurso|bloqueio_aplica)\(/.test(q.text)));
  await criarBloqueioAgenda({ data: DIA, diaInteiro: true, motivo: 'x', empresaId: A, estabelecimentoId: A1 }, b.db);
  assert.equal(b.bloqueios[0].empresa_id, null, 'sem a coluna, bloqueio continua global como antes');
  assert.deepEqual(await escopoDaEmpresa(b.db, A, A1), { empresaId: A, estabelecimentoId: null });
  assert.deepEqual(await escopoDoFechamento(b.db, 'f1'), ESCOPO_GLOBAL);
});

test('com a 062: mesma empresa e unidade conflita; outra empresa e outra unidade não', async () => {
  const b = banco({ ocupacoes: [ocupacao('fA1', A, A1)] });
  assert.equal(await statusTurno(b, { empresaId: A, estabelecimentoId: A1 }), 'INDISPONIVEL', 'mesma unidade');
  assert.equal(await statusTurno(b, { empresaId: A, estabelecimentoId: A2 }), 'DISPONIVEL', 'outra unidade da mesma empresa');
  assert.equal(await statusTurno(b, { empresaId: B, estabelecimentoId: B1 }), 'DISPONIVEL', 'outra empresa no mesmo horário');
  assert.equal(await statusTurno(b, { empresaId: A, estabelecimentoId: null }), 'INDISPONIVEL', 'visão da empresa inteira é conservadora');
  assert.equal(await statusTurno(b), 'INDISPONIVEL', 'sem escopo = global (conservador)');
});

test('com a 062: bloqueio por unidade, por empresa inteira e global legado', async () => {
  const b = banco({ bloqueios: [
    { id: 'u', data: DIA, dia_inteiro: true, horario_inicio: null, horario_fim: null, empresa_id: A, estabelecimento_id: A1, ativo: true },
  ] });
  assert.equal(await statusTurno(b, { empresaId: A, estabelecimentoId: A1 }), 'INDISPONIVEL');
  assert.equal(await statusTurno(b, { empresaId: A, estabelecimentoId: A2 }), 'DISPONIVEL', 'bloqueio de unidade não alcança a outra');
  b.bloqueios.push({ id: 'e', data: DIA, dia_inteiro: true, horario_inicio: null, horario_fim: null, empresa_id: A, estabelecimento_id: null, ativo: true });
  assert.equal(await statusTurno(b, { empresaId: A, estabelecimentoId: A2 }), 'INDISPONIVEL', 'bloqueio da empresa inteira');
  assert.equal(await statusTurno(b, { empresaId: B, estabelecimentoId: B1 }), 'DISPONIVEL', 'não alcança outra empresa');
  b.bloqueios.push({ id: 'g', data: DIA, dia_inteiro: true, horario_inicio: null, horario_fim: null, empresa_id: null, estabelecimento_id: null, ativo: true });
  assert.equal(await statusTurno(b, { empresaId: B, estabelecimentoId: B1 }), 'INDISPONIVEL', 'bloqueio sem dono continua global');
});

test('remarcação/edição: o escopo vem da contratação gravada, nunca do pedido', async () => {
  const b = banco({ fechamentos: { fA2: { empresaId: A, estabelecimentoId: A2 } }, ocupacoes: [ocupacao('fA1', A, A1), ocupacao('fA2', A, A2)] });
  const dia = await consultarDisponibilidadeData(DIA, b.db, 'fA2');
  assert.equal(dia.periodos[0].horarios[0].status, 'DISPONIVEL', 'exclui a própria contratação e não vê a outra unidade');
  const explicito = await consultarDisponibilidadeData(DIA, b.db, undefined, { fechamentoId: 'fA2' });
  assert.equal(explicito.periodos[0].horarios[0].status, 'INDISPONIVEL', 'sem excluir, a própria reserva ocupa o recurso');
  await assert.rejects(revalidarHorarioSelecionado({ data: DIA, codigoPeriodo: 'TURNO_1', inicio: '11:00', fim: '15:00', ajusteMinutos: 0 }, b.db, { empresaId: A, estabelecimentoId: A1 }),
    (e: unknown) => e instanceof AvailabilityServiceError && e.code === 'HORARIO_NAO_DISPONIVEL');
});

test('unidade: só da empresa comprovada; única é automática; várias exigem escolha na gravação', async () => {
  const b = banco({ unidades: { [A]: [A1, A2], [B]: [B1] } });
  assert.deepEqual(await escopoDaEmpresa(b.db, B), { empresaId: B, estabelecimentoId: B1 });
  assert.deepEqual(await escopoDaEmpresa(b.db, A), { empresaId: A, estabelecimentoId: null }, 'consulta: empresa inteira');
  await assert.rejects(escopoDaEmpresa(b.db, A, null, { exigirUnidade: true }), (e: unknown) => e instanceof AvailabilityServiceError && e.code === 'UNIDADE_OBRIGATORIA');
  await assert.rejects(escopoDaEmpresa(b.db, A, B1), (e: unknown) => e instanceof AvailabilityServiceError && e.code === 'UNIDADE_INVALIDA', 'unidade de outra empresa');
  assert.deepEqual(await escopoDaEmpresa(b.db, A, A2, { exigirUnidade: true }), { empresaId: A, estabelecimentoId: A2 });
});

test('agenda pública (D4): só configuração do servidor; com a 062, sem contexto ou inválida fica indisponível', async () => {
  const b = banco({ unidades: { [A]: [A1] } });
  let chamadas = 0;
  const conexao = () => { chamadas++; return b.db; };
  await assert.rejects(escopoPublico(conexao, {}), (e: unknown) => e instanceof AvailabilityServiceError && e.code === 'AGENDA_PUBLICA_NAO_CONFIGURADA' && e.httpStatus === 503,
    'com a 062, sem contexto nunca consulta a agenda de todas as empresas');
  const antes = banco({ v062: false });
  assert.deepEqual(await escopoPublico(() => antes.db, {}), ESCOPO_GLOBAL, 'sem a 062 a agenda ainda é global (comportamento anterior)');
  chamadas = 0;
  await assert.rejects(escopoPublico(conexao, { AGENDA_PUBLICA_EMPRESA_ID: 'nao-uuid' }));
  assert.equal(chamadas, 0, 'configuração malformada recusa antes de consultar o banco');
  assert.deepEqual(await escopoPublico(conexao, { AGENDA_PUBLICA_EMPRESA_ID: A }), { empresaId: A, estabelecimentoId: A1 });
  for (const env of [{ AGENDA_PUBLICA_EMPRESA_ID: 'nao-uuid' }, { AGENDA_PUBLICA_UNIDADE_ID: A1 }, { AGENDA_PUBLICA_EMPRESA_ID: A, AGENDA_PUBLICA_UNIDADE_ID: B1 },
    { AGENDA_PUBLICA_EMPRESA_ID: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }]) {
    await assert.rejects(escopoPublico(conexao, env), (e: unknown) => e instanceof AvailabilityServiceError && e.code === 'AGENDA_PUBLICA_INDISPONIVEL' && e.httpStatus === 503, JSON.stringify(env));
  }
  // O escopo público não lê nada do pedido: a assinatura só recebe a conexão e o ambiente do servidor.
  assert.equal(escopoPublico.length, 1);
});

test('bloqueios: criados com o escopo comprovado; global sem dono não é desativado pelo tenant; outra empresa = não encontrado', async () => {
  const b = banco({ bloqueios: [
    { id: 'g', data: DIA, dia_inteiro: true, horario_inicio: null, horario_fim: null, empresa_id: null, estabelecimento_id: null, ativo: true },
    { id: 'bB', data: DIA, dia_inteiro: true, horario_inicio: null, horario_fim: null, empresa_id: B, estabelecimento_id: B1, ativo: true },
  ] });
  const novo = await criarBloqueioAgenda({ data: DIA, horarioInicio: '11:00', horarioFim: '15:00', motivo: 'x', empresaId: A, estabelecimentoId: A1 }, b.db);
  assert.equal(novo.alcance, 'UNIDADE');
  assert.equal(b.bloqueios.at(-1)!.empresa_id, A);
  await assert.rejects(desativarBloqueioAgendaPorId('g', b.db, { empresaId: A, estabelecimentoId: A1 }), (e: unknown) => e instanceof AvailabilityServiceError && e.code === 'BLOQUEIO_SEM_DONO');
  assert.equal(await desativarBloqueioAgendaPorId('bB', b.db, { empresaId: A, estabelecimentoId: A1 }), false);
  assert.equal(b.bloqueios.find((x) => x.id === 'bB')!.ativo, true, 'bloqueio de outra empresa intacto');
  assert.equal(await desativarBloqueioAgendaPorId(novo.id, b.db, { empresaId: A, estabelecimentoId: A1 }), true);
  b.bloqueios.push({ id: 'x2', data: DIA, dia_inteiro: false, horario_inicio: '11:00:00', horario_fim: '15:00:00', empresa_id: B, estabelecimento_id: B1, ativo: true });
  assert.equal(await desativarBloqueiosExatos({ data: DIA, horarioInicio: '11:00:00', horarioFim: '15:00:00' }, b.db, { empresaId: A, estabelecimentoId: A1 }), 0, 'não desativa o de outra empresa');
  await existeBloqueioAgendaAtivoExato({ data: DIA, diaInteiro: true }, b.db, { empresaId: A, estabelecimentoId: A1 });
  assert.match(b.sql.at(-1)!.text, /empresa_id IS NOT DISTINCT FROM \$5::uuid AND estabelecimento_id IS NOT DISTINCT FROM \$6::uuid/);
  assert.deepEqual(b.sql.at(-1)!.values.slice(4), [A, A1]);
});

test('confirmação: com a 062 o escopo do conflito vem da própria contratação no SQL (ausente = global)', async () => {
  const b = banco();
  await verificarConflitoAgendaParaConfirmacao({ fechamentoId: 'f1', data: DIA, horarioInicio: '11:00', horarioFim: '15:00' }, b.db);
  const q = b.sql.at(-1)!;
  assert.match(q.text, /SELECT \(SELECT empresa_id FROM fechamentos WHERE id = \$1::uuid\) AS e/);
  assert.match(q.text, /kidmais062_mesmo_recurso\(alvo\.e, alvo\.u, f\.empresa_id, f\.estabelecimento_id\)/);
  assert.match(q.text, /kidmais062_bloqueio_aplica\(b\.empresa_id, b\.estabelecimento_id, alvo\.e, alvo\.u\)/);
  assert.equal(q.values.length, 4, 'nenhum escopo vem do chamador');
  const legado = banco({ v062: false });
  await verificarConflitoAgendaParaConfirmacao({ fechamentoId: 'f1', data: DIA, horarioInicio: '11:00', horarioFim: '15:00' }, legado.db);
  assert.match(legado.sql.at(-1)!.text, /FROM kidmais_ocupacoes_operacionais\(\$2::date,\$2::date\) f/);
});

test('turnos (D5): resolução unidade → empresa → global, sem misturar níveis', async () => {
  const b = banco();
  await listarConfiguracoesAgendaAtivas(b.db, { empresaId: A, estabelecimentoId: A1 });
  const q = b.sql.at(-1)!;
  assert.match(q.text, /WHERE nivel = \(SELECT max\(nivel\) FROM candidatas\)/);
  assert.match(q.text, /empresa_id IS NULL\s+OR \(empresa_id = \$1::uuid AND \(estabelecimento_id IS NULL OR estabelecimento_id = \$2::uuid\)\)/);
  assert.deepEqual(q.values, [A, A1]);
});
