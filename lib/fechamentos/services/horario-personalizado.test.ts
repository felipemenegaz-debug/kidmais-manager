import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * Correção de contrato com horário fora do padrão (08/11/2026): só com `horarioPersonalizado`, período configurado na data,
 * fim depois do início e o intervalo EXATO sem conflito (reservas e bloqueios do recurso). Sem a marca, vale a regra
 * oficial (candidatos do período). Contrato assinado (preparação operacional) continua só com os horários oficiais.
 * Sem banco: dependências simuladas.
 */
type Chamadas = { intervalo: unknown[][]; locks: string[] };
const TURNO = [{ inicio: '17:00', fim: '21:00', ajusteMinutos: 0, status: 'DISPONIVEL' }];

function carregar(arquivo: string, mocks: Record<string, unknown>) {
  const exports: Record<string, unknown> = {};
  const js = ts.transpileModule(readFileSync(arquivo, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'exports', js)((id: string) => mocks[id] ?? {}, exports);
  return exports;
}
class Recusa extends Error { constructor(_code: string, message: string) { super(message); } }

function edicao(periodos: unknown[], intervaloLivre: boolean) {
  const chamadas: Chamadas = { intervalo: [], locks: [] };
  const m = carregar('lib/fechamentos/services/edicao-administrativa.service.ts', {
    './errors': { FechamentoServiceError: Recusa },
    './edicao-administrativa-schema': { edicaoFestaSchema: { parse: (x: unknown) => x } },
    '../repositories': { empresaDoFechamentoComTrava: async () => 'empresa' },
    '../../comercial/services': { calcularResumoComercial: async () => ({ pacote: { pacote: { id: 'p', convidadosMinimos: 1 } }, adicionais: { itens: [] } }) },
    '../../comercial/composicao': { listarCodigosInclusos: async () => [] },
    '../../disponibilidade/repositories': { adquirirLockConfirmacaoAgenda: async (dia: string) => { chamadas.locks.push(dia); } },
    '../../disponibilidade/services': {
      consultarDisponibilidadeData: async () => ({ periodos }),
      intervaloSemConflito: async (...args: unknown[]) => { chamadas.intervalo.push(args); return intervaloLivre; },
    },
  });
  return { m: m as { calcularEdicaoFechamento: (f: unknown, i: unknown, tx: unknown) => Promise<unknown>; horarioPersonalizadoLivre: (...a: unknown[]) => Promise<boolean> }, chamadas };
}
const F = { id: 'f', dataEvento: '2026-11-20', horarioInicio: '17:00:00', horarioFim: '21:00:00', configuracaoAgendaId: 'noite', pacoteId: 'p', convidados: 40 };
const pedido = (mudanca: Record<string, unknown> = {}) => ({ acao: 'editar_festa', motivo: 'Cliente pediu estender', dataEvento: '2026-11-20', configuracaoAgendaId: 'noite', horarioInicio: '18:00', horarioFim: '22:30', pacoteId: 'p', convidados: 40, adicionais: [], ...mudanca });
const AGENDA = /Data\/horário indisponível|Período da agenda|fim do horário|bate com outra festa/;
/** Passou da agenda: resolve ou falha depois dela, por dependência não simulada. */
async function passouDaAgenda(p: Promise<unknown>) {
  try { await p; } catch (e) { assert.doesNotMatch((e as Error).message, AGENDA); }
}

test('sem a marca: horário fora das opções do período continua recusado pela regra oficial', async () => {
  const { m, chamadas } = edicao([{ configuracaoId: 'noite', horarios: TURNO }], true);
  await assert.rejects(m.calcularEdicaoFechamento(F, pedido(), {}), /fora das opções oficiais/);
  assert.equal(chamadas.intervalo.length, 0);
});

test('com a marca e intervalo livre: aceito, conferindo o intervalo exato e excluindo a própria contratação', async () => {
  const { m, chamadas } = edicao([{ configuracaoId: 'noite', horarios: TURNO }], true);
  const tx = {};
  await passouDaAgenda(m.calcularEdicaoFechamento(F, pedido({ horarioPersonalizado: true }), tx));
  assert.deepEqual(chamadas.intervalo, [['2026-11-20', '18:00', '22:30', tx, 'f']]);
  assert.deepEqual(chamadas.locks, ['2026-11-20']);
});

test('com a marca: conflito, fim antes do início ou período sem configuração são recusados', async () => {
  const ocupado = edicao([{ configuracaoId: 'noite', horarios: TURNO }], false);
  await assert.rejects(ocupado.m.calcularEdicaoFechamento(F, pedido({ horarioPersonalizado: true }), {}), /bate com outra festa ou bloqueio/);
  const invertido = edicao([{ configuracaoId: 'noite', horarios: TURNO }], true);
  await assert.rejects(invertido.m.calcularEdicaoFechamento(F, pedido({ horarioPersonalizado: true, horarioInicio: '22:00', horarioFim: '18:00' }), {}), /fim do horário precisa ser depois/);
  assert.equal(invertido.chamadas.intervalo.length, 0);
  const semPeriodo = edicao([], true);
  await assert.rejects(semPeriodo.m.calcularEdicaoFechamento(F, pedido({ horarioPersonalizado: true }), {}), /Período da agenda não configurado/);
});

test('horário oficial disponível com a marca segue pela regra oficial, sem consultar o intervalo', async () => {
  const { m, chamadas } = edicao([{ configuracaoId: 'noite', horarios: [...TURNO, { inicio: '18:00', fim: '22:30', ajusteMinutos: 0, status: 'DISPONIVEL' }] }], false);
  await passouDaAgenda(m.calcularEdicaoFechamento(F, pedido({ horarioPersonalizado: true }), {}));
  assert.equal(chamadas.intervalo.length, 0);
});

test('horarioPersonalizadoLivre: sem período ou com fim ≤ início é falso sem consultar a agenda; senão, intervalo exato (HH:MM)', async () => {
  const { m, chamadas } = edicao([], true);
  const tx = {};
  assert.equal(await m.horarioPersonalizadoLivre(tx, 'f', { dataEvento: '2026-11-20', horarioInicio: '18:00', horarioFim: '22:30' }, false), false);
  assert.equal(await m.horarioPersonalizadoLivre(tx, 'f', { dataEvento: '2026-11-20', horarioInicio: '18:00', horarioFim: '18:00' }, true), false);
  assert.equal(chamadas.intervalo.length, 0);
  assert.equal(await m.horarioPersonalizadoLivre(tx, 'f', { dataEvento: '2026-11-20', horarioInicio: '18:00:00', horarioFim: '22:30:00' }, true), true);
  assert.deepEqual(chamadas.intervalo, [['2026-11-20', '18:00', '22:30', tx, 'f']]);
});

function aplicacao(periodos: unknown[], intervaloLivre: boolean) {
  const chamadas = { intervalo: [] as unknown[][], persistiu: 0 };
  const fechamento = { ...F, horarioInicio: '18:00', horarioFim: '22:30', clienteId: 'cl', aniversarianteId: 'a' };
  const m = carregar('lib/contratos/services/revisao-inicial.ts', {
    './errors': { ContratoServiceError: Recusa },
    './snapshot-core': { hashSnapshotContrato: () => 'base' },
    '../../fechamentos/repositories': { buscarFechamentoPorId: async () => ({ ...F, clienteId: 'cl', aniversarianteId: 'a' }), listarAdicionaisDoFechamento: async () => [] },
    '../../fechamentos/repositories/edicao.repository': { persistirEdicaoFechamento: async () => { chamadas.persistiu++; } },
    '../../fechamentos/services/pacote-snapshot': { fotografarEstadoFechamento: async () => null },
    '../../clientes/repositories': { registrarAuditoria: async () => undefined },
    '../../disponibilidade/repositories': { adquirirLockConfirmacaoAgenda: async () => undefined },
    '../../disponibilidade/services': { consultarDisponibilidadeData: async () => ({ periodos }) },
    '../../fechamentos/services/edicao-administrativa.service': {
      // Mesmo contrato da função real (testada abaixo): sem período configurado nunca é livre.
      horarioPersonalizadoLivre: async (...args: unknown[]) => { chamadas.intervalo.push(args); return args[3] === true && intervaloLivre; },
    },
  }) as { aplicarRevisaoInicial: (tx: unknown, v: unknown, p: unknown) => Promise<void> };
  const tx = { query: async (sql: string) => ({ rows: sql.includes('contrato_fluxos') ? [{ versao_vigente_id: null, versao_em_preparacao_id: 'v2' }] : [{ parte: 'KIDMAIS' }, { parte: 'CLIENTE' }] }) };
  const v = { id: 'v2', contratoId: 'c', status: 'ASSINADA', snapshotHash: 'h', snapshot: { fechamento: { id: 'f' } } };
  const proposta = (marca: boolean) => ({ fechamento, resumo: {}, baseHash: 'base', motivo: 'Cliente pediu estender', ...(marca ? { horarioPersonalizado: true } : {}) });
  return { aplicar: (marca: boolean) => m.aplicarRevisaoInicial(tx, v, proposta(marca)), chamadas };
}

test('revisão inicial: proposta marcada aplica o horário fora do padrão quando o intervalo exato está livre', async () => {
  const { aplicar, chamadas } = aplicacao([{ configuracaoId: 'noite', horarios: TURNO }], true);
  await aplicar(true);
  assert.equal(chamadas.persistiu, 1);
  assert.equal(chamadas.intervalo.length, 1);
  assert.equal(chamadas.intervalo[0][3], true, 'período configurado');
});

test('revisão inicial: sem a marca, com conflito ou sem período, nada é aplicado', async () => {
  const casos: Array<[unknown[], boolean, boolean]> = [[[{ configuracaoId: 'noite', horarios: TURNO }], true, false], [[{ configuracaoId: 'noite', horarios: TURNO }], false, true], [[], true, true]];
  for (const [periodos, livre, marca] of casos) {
    const { aplicar, chamadas } = aplicacao(periodos, livre);
    await assert.rejects(aplicar(marca), /indisponível\. Nenhuma alteração foi aplicada/);
    assert.equal(chamadas.persistiu, 0);
  }
});

test('contrato assinado (preparação operacional) recusa a marca antes de alterar qualquer campo; tela só oferece fora da preparação', () => {
  const fonte = readFileSync('lib/fechamentos/services/revisao-operacional.service.ts', 'utf8');
  const editar = fonte.slice(fonte.indexOf('export async function editarPreparacao('), fonte.indexOf('export async function congelarPreparacao('));
  const iMarca = editar.indexOf('if (input.horarioPersonalizado)');
  assert.ok(iMarca > 0 && iMarca < editar.indexOf('const empresaAutorizada'), 'recusa logo no início');
  const rota = readFileSync('app/api/admin/contratos/versoes/[versaoId]/edicao/route.ts', 'utf8');
  assert.ok(rota.includes('horarioPersonalizado: !preparada'));
  const tela = readFileSync('components/admin/EdicaoFesta.tsx', 'utf8');
  assert.ok(tela.includes("{ctx.horarioPersonalizado && <option value=\"outro\">Outro horário (fora do padrão)…</option>}"));
  assert.ok(tela.includes('horarioPersonalizado: personalizado ? true : undefined'));
});
