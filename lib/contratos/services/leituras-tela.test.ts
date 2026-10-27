import test from 'node:test';
import assert from 'node:assert/strict';
import { estadoFestaDoContrato, leiturasDaTela, salaoDaVersao, salaoDoContrato } from './leituras-tela.ts';

type Linha = Record<string, unknown>;
/** tx falso: registra o SQL e responde por trecho. Só aceita SELECT (a tela não grava). */
function tx(respostas: Array<[RegExp, Linha[]]>) {
  const sqls: Array<{ sql: string; params?: unknown[] }> = [];
  return { sqls, query: async (sql: string, params?: unknown[]) => {
    assert.match(sql.trim(), /^SELECT/i, 'somente leitura');
    sqls.push({ sql, params });
    return { rows: respostas.find(([re]) => re.test(sql))?.[1] ?? [] };
  } } as unknown as { sqls: typeof sqls; query: (sql: string, params?: unknown[]) => Promise<{ rows: Linha[] }> };
}

test('salão: sem 093/094 não cita colunas; com schema, presa à empresa, à unidade e ao contrato', async () => {
  const sem = tx([[/to_regclass/, [{ tabela: false, festa: false, revisao: false, unidade: false }]]]);
  assert.deepEqual(await salaoDoContrato(sem as never, 'c', 'e'), { salao: null, salaoAlteracao: null });
  assert.equal(sem.sqls.length, 1);
  const com = tx([[/to_regclass/, [{ tabela: true, festa: true, revisao: true, unidade: true }]], [/FROM contratos c/, [{ nome: 'Salão Encantado' }]], [/FROM fechamento_revisoes r/, [{ nome: 'Salão Azul' }]]]);
  assert.deepEqual(await salaoDoContrato(com as never, 'c', 'e'), { salao: 'Salão Encantado', salaoAlteracao: 'Salão Azul' });
  for (const { sql, params } of com.sqls.slice(1)) {
    assert.match(sql, /s\.empresa_id = \$2::uuid/); assert.match(sql, /f\.empresa_id = \$2::uuid/);
    assert.match(sql, /s\.estabelecimento_id IS NOT DISTINCT FROM f\.estabelecimento_id/);
    assert.deepEqual(params, ['c', 'e']);
  }
  assert.match(com.sqls[2].sql, /c\.fechamento_id = r\.fechamento_id/);
  // Só a coluna da festa: a da revisão não é citada.
  const parcial = tx([[/to_regclass/, [{ tabela: true, festa: true, revisao: false, unidade: true }]]]);
  await salaoDoContrato(parcial as never, 'c', 'e');
  assert.equal(parcial.sqls.some(s => /fechamento_revisoes r/.test(s.sql)), false);
});

const snapshot = (data: string, inicio: string, fim: string) => ({ evento: { data, horarioInicio: inicio, horarioFim: fim } });
const detalhe = (status: string, snap = snapshot('2027-04-20', '10:00:00', '14:00:00')) => ({
  contrato: { status }, fluxo: { versao_vigente_id: 'v1', versao_em_preparacao_id: null },
  versoes: [{ id: 'v1', numero_versao: 1, status: 'ASSINADA', snapshot: snap }],
});

test('estado da festa: sem festa → null; contrato cancelado; festa invalidada → REMOVIDA; passagem da meia-noite em SP', async () => {
  const agora = new Date('2027-04-21T01:00:00Z'); // 22h do dia 20 em São Paulo
  assert.equal(await estadoFestaDoContrato(tx([]) as never, 'c', 'e', detalhe('ASSINADO'), agora), null);
  const ativa = () => tx([[/FROM festas f/, [{ invalidada: false }]]]);
  assert.equal(await estadoFestaDoContrato(ativa() as never, 'c', 'e', detalhe('CANCELADO'), agora), 'CANCELADA');
  assert.equal(await estadoFestaDoContrato(tx([[/FROM festas f/, [{ invalidada: true }]]]) as never, 'c', 'e', detalhe('ASSINADO'), agora), 'REMOVIDA');
  assert.equal(await estadoFestaDoContrato(ativa() as never, 'c', 'e', detalhe('ASSINADO'), agora), 'REALIZADA');
  // Festa das 20h às 2h: às 22h ainda é HOJE; às 3h do dia seguinte, REALIZADA.
  const noite = detalhe('ASSINADO', snapshot('2027-04-20', '20:00:00', '02:00:00'));
  assert.equal(await estadoFestaDoContrato(ativa() as never, 'c', 'e', noite, agora), 'HOJE');
  assert.equal(await estadoFestaDoContrato(ativa() as never, 'c', 'e', noite, new Date('2027-04-21T06:00:00Z')), 'REALIZADA');
  // A leitura alcança a festa invalidada (sem filtro invalidada_em IS NULL) e fica presa à empresa.
  const t = ativa(); await estadoFestaDoContrato(t as never, 'c', 'e', detalhe('ASSINADO'), agora);
  assert.doesNotMatch(t.sqls[0].sql, /invalidada_em IS NULL\s*(AND|LIMIT|$)/); assert.match(t.sqls[0].sql, /fe\.empresa_id = \$2::uuid/);
});

test('leiturasDaTela: contrato de outra empresa não lê nada; com posse, usa a versão de referência do próprio contrato', async () => {
  const fora = tx([]);
  assert.deepEqual(await leiturasDaTela(fora as never, 'c', 'e'), { salao: null, salaoAlteracao: null, estadoFesta: null, salaoContrato: null, estadoVersao: null });
  assert.equal(fora.sqls.length, 1); assert.match(fora.sqls[0].sql, /fe\.empresa_id = \$2::uuid/);
  const dentro = tx([
    [/SELECT c\.status FROM contratos/, [{ status: 'ASSINADO' }]],
    [/FROM contrato_fluxos/, [{ versao_vigente_id: 'v1', versao_em_preparacao_id: null }]],
    [/FROM contrato_versoes/, [{ id: 'v1', numero_versao: 1, status: 'ASSINADA', snapshot: snapshot('2020-01-01', '10:00:00', '14:00:00') }]],
    [/to_regclass/, [{ tabela: false, festa: false, revisao: false, unidade: false }]],
    [/FROM festas f/, [{ invalidada: false }]],
  ]);
  assert.deepEqual(await leiturasDaTela(dentro as never, 'c', 'e', new Date('2027-01-01T12:00:00Z')), { salao: null, salaoAlteracao: null, salaoContrato: null, estadoVersao: null, estadoFesta: 'REALIZADA' });
});

// S-E (R3-E3): comparação explícita do salão do documento V3 com a festa (V1/V2 → null).
test('salaoDaVersao: V3 atual, desatualizada por salão e por data, troca em andamento; V1 sem leitura', async () => {
  const v3 = (salao: { id: string; nome: string } | null) => ({ ...(snapshot('2026-12-05', '10:00:00', '22:00:00') as object), schemaVersao: 3,
    evento: { data: '2026-12-05', horarioInicio: '10:00', horarioFim: '22:00', configuracaoAgendaId: 'cfg', salao } });
  const fluxo = { versao_vigente_id: 'v1', versao_em_preparacao_id: null };
  const caso = async (festa: Record<string, unknown> | null, snap: unknown) => {
    const t = tx([[/FROM contratos c JOIN fechamentos f/, festa ? [festa] : []]]);
    return salaoDaVersao(t as never, 'c', 'e', fluxo as never, [{ id: 'v1', numero_versao: 1, status: 'ASSINADA', snapshot: snap }] as never);
  };
  const festa = { salao: 's1', data: '2026-12-05', inicio: '10:00:00', fim: '22:00:00', cfg: 'cfg', revisao: false };
  assert.deepEqual(await caso(festa, v3({ id: 's1', nome: 'Kids' })), { salaoContrato: 'Kids', estadoVersao: { estado: 'atual' } });
  assert.deepEqual(await caso({ ...festa, salao: null }, v3({ id: 's1', nome: 'Kids' })), { salaoContrato: 'Kids', estadoVersao: { estado: 'atual' } }, 'festa ainda sem salão');
  assert.deepEqual(await caso({ ...festa, salao: 's2' }, v3({ id: 's1', nome: 'Kids' })), { salaoContrato: 'Kids', estadoVersao: { estado: 'desatualizada', motivo: 'salao' } });
  assert.deepEqual(await caso({ ...festa, cfg: 'outra' }, v3({ id: 's1', nome: 'Kids' })), { salaoContrato: 'Kids', estadoVersao: { estado: 'desatualizada', motivo: 'data' } });
  assert.deepEqual(await caso({ ...festa, salao: 's2', revisao: true }, v3({ id: 's1', nome: 'Kids' })), { salaoContrato: 'Kids', estadoVersao: { estado: 'troca_em_andamento' } });
  assert.deepEqual(await caso(festa, snapshot('2026-12-05', '10:00:00', '22:00:00')), { salaoContrato: null, estadoVersao: null });
  assert.deepEqual(await caso(festa, v3(null)), { salaoContrato: null, estadoVersao: null });
});
