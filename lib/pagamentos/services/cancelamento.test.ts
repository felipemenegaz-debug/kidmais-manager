import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import * as domain from '../../festas/domain.ts';
import { situacaoCobranca } from './cancelamento-core.ts';
import { PagamentoServiceError } from './errors.ts';
import * as financeiroCore from './alteracao-financeira-core.ts';
import { hashSnapshotContrato } from '../../contratos/services/snapshot-core.ts';
import { nomePapelSistema } from '../../autenticacao/papeis.ts';

function carregar(file: string, deps: Record<string, unknown>) {
  const exports: Record<string, (...args: unknown[]) => unknown> = {};
  const js = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'exports', js)((id: string) => {
    assert(id in deps, `Import não isolado: ${id}`); return deps[id];
  }, exports);
  return exports;
}
type Row = Record<string, unknown>;
function ambiente(recebimentos: Row[] = [], consolidado = false, falha = '') {
  let state = {
    contrato: { id: 'c', cliente_id: 'cliente', status: 'ASSINADO', cancelado_em: null as string | null, versao_id: 'v' },
    festa: { id: 'f', contrato_id: 'c', revisao: 1, invalidada_em: null },
    versao: { id: 'v', status: 'ASSINADA', snapshot: { comercial: { valorFinalContrato: 9700 } }, assinaturas: ['KIDMAIS', 'CLIENTE'] },
    pagamentos: [{ id: 'p', status: 'AGUARDANDO_PAGAMENTO', valor: 9700, cancelado_em: null as string | null }],
    planos: [{ id: 'historico', status: 'SUBSTITUIDO' }, { id: 'ativo', status: 'ATIVO' }],
    parcelas: [{ id: 'h', plano: 'historico', valor: 5000, status: 'CANCELADA' },
      { id: 'preservada', plano: 'historico', valor: 2000, status: consolidado ? 'PENDENTE' : 'CANCELADA' },
      { id: 'a', plano: 'ativo', valor: 2000, status: recebimentos.length ? 'PARCIALMENTE_PAGA' : 'PENDENTE' },
      { id: 'b', plano: 'ativo', valor: 7700, status: 'PENDENTE' },
      { id: 'paga', plano: 'historico', valor: 1, status: 'PAGA' }],
    recebimentos: structuredClone(recebimentos), devolucoes: [], estornos: [],
    cronograma: consolidado ? { estado: 'ATIVO', itens: ['preservada', 'a', 'b'] } : null,
    auditoria: [] as Row[], historico: [] as Row[], eventos: [] as Row[],
  };
  const initial = structuredClone(state);
  const tx = { query: async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (falha && s.startsWith(falha)) throw Error('Falha injetada');
    let rows: unknown[] = [];
    if (s.startsWith('SELECT * FROM festas')) rows = [structuredClone(state.festa)];
    else if (s.includes('FROM festa_usuario_capacidades')) rows = [{ id: 'cap' }];
    else if (s.startsWith('SELECT * FROM festa_eventos')) rows = state.eventos.filter(e => e.chave_idempotencia === params[0]);
    else if (s.startsWith('SELECT c.*,f.cliente_id')) rows = [structuredClone(state.contrato)];
    else if (s.includes('FROM festa_contagens_convidados') || s.includes('FROM fechamento_revisoes')) rows = [];
    else if (s.startsWith('SELECT metadata FROM eventos_historico_cliente')) rows = state.historico.filter(e => e.tipoEvento === 'CONTRATO_CANCELADO');
    else if (s.startsWith('SELECT public.kidmais019_bloquear_contrato')) rows = [];
    else if (s.startsWith('SELECT p.id,p.status FROM pagamentos')) rows = structuredClone(state.pagamentos);
    else if (s.startsWith('SELECT count(*)::int quantidade')) rows = [{ quantidade: state.recebimentos.length,
      confirmado: String(state.recebimentos.filter(r => r.status === 'CONFIRMADO').reduce((n, r) => n + Number(r.valor), 0)) }];
    else if (s.startsWith('UPDATE pagamento_parcelas')) {
      assert(s.includes("pl.status='ATIVO' OR EXISTS"));
      for (const p of state.parcelas) if (['PENDENTE', 'PARCIALMENTE_PAGA', 'ESTORNADA'].includes(p.status) &&
        (state.planos.some(pl => pl.id === p.plano && pl.status === 'ATIVO') || state.cronograma?.itens.includes(p.id))) {
        p.status = 'CANCELADA'; rows.push({ id: p.id });
      }
    } else if (s.startsWith('UPDATE pagamento_planos')) {
      assert(s.includes("AND status='ATIVO'"));
      for (const p of state.planos) if (p.status === 'ATIVO') { p.status = 'CANCELADO'; rows.push({ id: p.id }); }
    } else if (s.startsWith('UPDATE pagamentos')) {
      state.pagamentos[0].status = 'CANCELADO'; state.pagamentos[0].cancelado_em = 'agora';
    } else if (s.startsWith('UPDATE contratos')) {
      state.contrato.status = 'CANCELADO'; state.contrato.cancelado_em = 'agora'; rows = [{ cancelado_em: 'agora' }];
    } else if (s.startsWith('UPDATE festas')) { state.festa.revisao++; rows = [structuredClone(state.festa)]; }
    else if (s.startsWith('INSERT INTO festa_eventos')) state.eventos.push({ festa_id: params[0], tipo: params[1], usuario_id: params[3], chave_idempotencia: params[6], payload_hash: params[7], dados_depois: params[10] });
    else throw Error('SQL não simulado: ' + s);
    return { rows, rowCount: rows.length };
  } };
  const audit = { registrarAuditoria: async (input: Row, executor: unknown) => {
    assert.equal(executor, tx); if (falha === 'auditoria' && input.acao === 'PAGAMENTO_CANCELADO') throw Error('Falha injetada');
    state.auditoria.push(structuredClone(input));
  } };
  const history = { registrarEventoHistorico: async (input: Row, executor: unknown) => { assert.equal(executor, tx); state.historico.push(structuredClone(input)); } };
  const financeiro = carregar('lib/pagamentos/services/cancelamento.service.ts', {
    '../../clientes/repositories/auditoria.repository': audit, '../../clientes/repositories/historico.repository': history,
  });
  const contrato = carregar('lib/contratos/services/cancelamento.service.ts', {
    '../../pagamentos/services/cancelamento.service': financeiro,
    '../../fechamentos/repositories/revisao.repository': {}, '../../fechamentos/services/revisao-operacional.service': {},
    '../../clientes/repositories/auditoria.repository': audit, '../../clientes/repositories/historico.repository': history,
    '../../festas/domain': domain,
  });
  const sessao = { usuario_id: 'admin', nome: 'Ficticio', papel: 'REPRESENTANTE_AUTORIZADO' };
  const festa = carregar('lib/festas/service.ts', {
    './ambiente': { validarAmbienteFesta: async () => {} }, './buffet': {}, './perfis': {}, zod: {},
    './politica': { politicaOperacao: () => ({ corrigir: false, motivoObrigatorio: true }) },
    'node:crypto': { createHash }, './domain': domain,
    './schema': { comandoSchema: { parse: (v: unknown) => v } },
    './repository': { contrato: async () => structuredClone(state.contrato) },
    '../contratos/services/cancelamento.service': contrato,
    '../clientes/repositories/auditoria.repository': audit,
    '../pagamentos/services/financeiro-consulta.service': {},
    '../autenticacao/service': { consultarSessao: async () => sessao },
    '../autenticacao/papeis': { nomePapelSistema },
    '../db/postgres': { withTransaction: async (fn: (executor: unknown) => Promise<unknown>) => {
      const before = structuredClone(state); try { return await fn(tx); } catch (e) { state = before; throw e; }
    } },
  });
  const comando = { acao: 'cancelar_contratacao', revisao: 1, versaoId: 'v', chave: 'chave', motivo: 'Teste de cancelamento' };
  return { state: () => state, initial, executar: async () => festa.comandarFesta('f', comando, { token: 'sessao', requestId: 'request', userAgent: null }) };
}

test('cancelamento real da Festa encerra cobrança, preserva versões e plano substituído; replay não duplica', async () => {
  const a = ambiente(); await a.executar(); const s = a.state();
  assert.equal(s.contrato.status, 'CANCELADO'); assert.equal(s.festa.invalidada_em, null);
  assert.equal(s.pagamentos[0].status, 'CANCELADO'); assert(s.pagamentos[0].cancelado_em);
  assert.deepEqual(s.planos.map(p => p.status), ['SUBSTITUIDO', 'CANCELADO']);
  assert(s.parcelas.every(p => p.status === 'CANCELADA' || p.status === 'PAGA'));
  assert.deepEqual(s.versao, a.initial.versao); assert.equal(s.pagamentos[0].valor, 9700);
  assert.deepEqual(s.parcelas.map(p => [p.id, p.valor]), a.initial.parcelas.map(p => [p.id, p.valor]));
  assert.equal(s.auditoria.filter(e => e.acao === 'PAGAMENTO_CANCELADO').length, 1);
  assert.equal(s.historico.filter(e => e.tipoEvento === 'PAGAMENTO_CANCELADO').length, 1);
  const before = structuredClone(s); await a.executar(); assert.deepEqual(a.state(), before);
  assert.equal(domain.estadoDerivado({}, true, false), 'CANCELADA');
});
for (const status of ['CONFIRMADO', 'PENDENTE', 'RECUSADO', 'CANCELADO']) test(`recebimento ${status} preservado e acerto sinalizado, sem estorno/devolução`, async () => {
  const a = ambiente([{ id: 'recebido', status, valor: 2000 }]); await a.executar(); const s = a.state();
  assert.deepEqual(s.recebimentos, a.initial.recebimentos); assert.deepEqual(s.devolucoes, []); assert.deepEqual(s.estornos, []);
  assert.equal(s.pagamentos[0].status, 'CANCELADO'); assert.equal(s.planos[1].status, 'CANCELADO');
  assert.equal(s.parcelas.find(p => p.id === 'a')?.status, 'CANCELADA');
  const dados = s.auditoria.find(e => e.acao === 'PAGAMENTO_CANCELADO')!.dadosDepois as Row;
  assert.equal(dados.acertoAdministrativoPendente, true); assert.equal(dados.recebimentosPreservados, 1);
  assert.equal(dados.valorConfirmadoPreservado, status === 'CONFIRMADO' ? '2000' : '0');
});
test('cronograma canônico preservado e parcelas herdadas encerradas sem mudar plano substituído', async () => {
  const a = ambiente([], true); await a.executar(); const s = a.state();
  assert.deepEqual(s.cronograma, a.initial.cronograma);
  assert.equal(s.planos[0].status, 'SUBSTITUIDO'); assert.equal(s.parcelas[1].status, 'CANCELADA');
});
test('contrato sem obrigação pode ser cancelado sem criar registros financeiros', async () => {
  const a = ambiente(); a.state().pagamentos = []; await a.executar();
  assert.equal(a.state().contrato.status, 'CANCELADO'); assert.deepEqual(a.state().pagamentos, []);
  assert(!a.state().auditoria.some(e => e.acao === 'PAGAMENTO_CANCELADO'));
});
for (const falha of ['UPDATE pagamento_planos', 'auditoria', 'UPDATE contratos', 'INSERT INTO festa_eventos']) test(`falha em ${falha} desfaz todo cancelamento`, async () => {
  const a = ambiente([], false, falha); await assert.rejects(a.executar(), /Falha injetada/);
  assert.deepEqual(a.state(), a.initial, 'contrato, financeiro, Festa e eventos voltam juntos');
});
test('projeção encerra cobrança sem inventar quitação nem crédito e conserva sinal de acerto', () => {
  assert.deepEqual(situacaoCobranca('ASSINADO', 'AGUARDANDO_PAGAMENTO', 0, 970000n), { encerrada: false, saldoACobrar: 970000n, acertoAdministrativoPendente: false });
  assert.deepEqual(situacaoCobranca('CANCELADO', 'CANCELADO', 0, 970000n), { encerrada: true, saldoACobrar: 0n, acertoAdministrativoPendente: false });
  assert.deepEqual(situacaoCobranca('CANCELADO', 'CANCELADO', 1, 770000n), { encerrada: true, saldoACobrar: 0n, acertoAdministrativoPendente: true });
});
test('alteração e reprogramação consolidadas não reabrem cobrança cancelada', () => {
  const service = carregar('lib/pagamentos/services/alteracao-financeira.service.ts', {
    'node:crypto': {}, '../../db/postgres': {}, '../../autenticacao/service': {}, '../../contratos/services/snapshot-core': {},
    '../repositories/alteracao-financeira.repository': {}, './cronograma.service': {},
    './alteracao-financeira-core': { recusarFinanceiro: (code: string, message: string) => { throw new PagamentoServiceError(code as 'PAGAMENTO_CANCELADO', message, 409); } },
  });
  for (const reprogramacao of [false, true]) assert.throws(() => service.simularPosicao({ contrato: { status: 'CANCELADO' }, pagamento: { status: 'CANCELADO' } }, {}, reprogramacao), { code: 'PAGAMENTO_CANCELADO' });
});

for (const consolidado of [false, true]) test(`consulta real sinaliza acerto e remove cobrança futura, consolidado=${consolidado}`, async () => {
  const snapshot = { comercial: { valorFinalContrato: 9700 }, evento: { data: '2028-03-31' } };
  const versao = { id: 'v', numero_versao: 1, status: 'ASSINADA', snapshot, snapshot_hash: hashSnapshotContrato(snapshot) };
  const queries: string[] = [];
  const tx = { query: async (sql: string) => {
    assert(sql.startsWith('SELECT'), 'consulta jamais escreve'); queries.push(sql);
    let rows: unknown[] = [];
    if (sql.startsWith('SELECT id,fechamento_id')) rows = [{ id: 'c', status: 'CANCELADO', versao_atual: 1 }];
    else if (sql.startsWith('SELECT p.id,p.contrato_versao_id')) rows = [{ id: 'p', contrato_versao_id: 'v', status: 'CANCELADO', valor_total_contratado: '9700' }];
    else if (sql.startsWith('SELECT v.id,v.numero_versao')) rows = [versao];
    else if (sql.startsWith('SELECT versao_vigente_id')) rows = [{ versao_vigente_id: 'v' }];
    else if (sql.includes('FROM pagamento_recebimentos')) rows = [{ id: 'r', status: 'CONFIRMADO', valor_bruto: '2000' }];
    else if (sql.startsWith('SELECT pp.id')) rows = [{ id: 'parcela', status: 'CANCELADA', plano_id: 'pl', valor_previsto: '9700', recebido: '2000', estornado: '0' }];
    else if (sql.includes('FROM pagamento_planos WHERE')) rows = [{ id: 'pl', status: 'CANCELADO', numero_versao: 1 }];
    else if (sql.includes('FROM pagamento_cronogramas WHERE') && consolidado) rows = [{ id: 'cr', estado: 'ATIVO', plano_id: 'pl' }];
    else if (sql.includes('FROM pagamento_cronograma_itens')) rows = [{ id: 'i', parcela_id: 'parcela', saldo_inicial_centavos: '970000', recebido_base_centavos: '0', estornado_base_centavos: '0' }];
    return { rows, rowCount: rows.length };
  } };
  const repository = carregar('lib/pagamentos/repositories/alteracao-financeira.repository.ts', {
    '../services/cancelamento-core': { situacaoCobranca }, '../../contratos/services/snapshot-core': { hashSnapshotContrato },
    '../services/alteracao-financeira-core': financeiroCore,
  });
  const result = await repository.lerPosicaoFinanceira(tx, 'c') as { cobranca: ReturnType<typeof situacaoCobranca>; futuro: unknown[]; posicao: { recebido: bigint; obrigacao: bigint; saldo: bigint } };
  assert.deepEqual(result.futuro, []); assert.equal(result.cobranca.saldoACobrar, 0n);
  assert.equal(result.cobranca.acertoAdministrativoPendente, true);
  assert.equal(result.posicao.recebido, 200000n); assert.equal(result.posicao.obrigacao, 970000n);
  assert.equal(result.posicao.saldo, 770000n, 'referência econômica preservada, sem baixa artificial');
  assert(queries.length > 10);
});
