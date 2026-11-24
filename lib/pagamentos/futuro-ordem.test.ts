import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { ordenarFuturoPorVencimento, proximaParcelaEmAberto } from './futuro-ordem.ts';
import * as futuroOrdem from './futuro-ordem.ts';
import * as financeiroCore from './services/alteracao-financeira-core.ts';
import { situacaoCobranca } from './services/cancelamento-core.ts';
import { hashSnapshotContrato } from '../contratos/services/snapshot-core.ts';

/**
 * Achado P1 do ensaio de 23/11/2026 (production, empresa de demonstração, festa F5 Theo): Pix parcelado
 * 2.315 + 2×2.000 (23/11, 23/12, 23/01), entrada paga e R$ 800 da parcela de 23/12. O topo dizia
 * "Próxima parcela: R$ 2.000,00 em 23/01/2027"; a certa é a de 23/12/2026 com saldo R$ 1.200,00.
 */
const ENTRADA = { parcelaId: 'p-entrada', vencimento: '2026-11-23', valorCentavos: '0' };
const DEZ = { parcelaId: 'p-dez', vencimento: '2026-12-23', valorCentavos: '120000' };
const JAN = { parcelaId: 'p-jan', vencimento: '2027-01-23', valorCentavos: '200000' };

test('Theo: parcelas fora de ordem e parcela de dezembro paga em parte → próxima é 23/12 com saldo R$ 1.200', () => {
  for (const ordem of [[ENTRADA, JAN, DEZ], [JAN, DEZ, ENTRADA], [JAN, ENTRADA, DEZ]]) {
    assert.deepEqual(proximaParcelaEmAberto(ordem), DEZ);
    assert.deepEqual(ordenarFuturoPorVencimento(ordem).map((i) => i.vencimento), ['2026-11-23', '2026-12-23', '2027-01-23']);
  }
});

test('próxima ignora parcela quitada mesmo que vença antes; sem saldo em aberto não há próxima', () => {
  assert.deepEqual(proximaParcelaEmAberto([{ ...DEZ, valorCentavos: '0' }, JAN, ENTRADA]), JAN);
  assert.equal(proximaParcelaEmAberto([ENTRADA, { ...DEZ, valorCentavos: '0' }]), undefined);
  assert.equal(proximaParcelaEmAberto([]), undefined);
});

test('ordenação não altera a lista recebida; empate de data usa o desempate e depois a ordem recebida', () => {
  const lista = [JAN, DEZ];
  ordenarFuturoPorVencimento(lista);
  assert.deepEqual(lista, [JAN, DEZ]);
  const a = { id: 'a', n: 3, vencimento: '2026-12-23' }, b = { id: 'b', n: 2, vencimento: '2026-12-23' };
  assert.deepEqual(ordenarFuturoPorVencimento([a, b], (i) => i.n).map((i) => i.id), ['b', 'a']);
  assert.deepEqual(ordenarFuturoPorVencimento([a, b]).map((i) => i.id), ['a', 'b']);
});

function carregar(file: string, deps: Record<string, unknown>) {
  const exports: Record<string, (...args: unknown[]) => unknown> = {};
  const js = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'exports', js)((id: string) => { assert(id in deps, `Import não isolado: ${id}`); return deps[id]; }, exports);
  return exports;
}

/** Leitura real do repositório com banco falso só de leitura; as parcelas chegam na ordem do id (UUID), como no banco. */
async function lerTheo(cronograma: boolean, vencimentoJan = '2027-01-23') {
  const snapshot = { comercial: { valorFinalContrato: 6315, condicaoPagamento: { forma: 'PIX_PARCELADO' } }, evento: { data: '2027-02-20' } };
  const versao = { id: 'v', numero_versao: 1, status: 'ASSINADA', snapshot, snapshot_hash: hashSnapshotContrato(snapshot) };
  // Ordem do id: entrada, janeiro, dezembro (a ordem que o ensaio viu na programação gravada).
  const parcelas = [
    { id: 'a-entrada', plano_id: 'pl', numero: 1, valor_previsto: '2315.00', vencimento: '2026-11-23', status: 'PAGA', confirma_reserva: true, recebido: '2315.00', estornado: '0' },
    { id: 'b-jan', plano_id: 'pl', numero: 3, valor_previsto: '2000.00', vencimento: vencimentoJan, status: 'PENDENTE', confirma_reserva: false, recebido: '0', estornado: '0' },
    { id: 'c-dez', plano_id: 'pl', numero: 2, valor_previsto: '2000.00', vencimento: '2026-12-23', status: 'PARCIAL', confirma_reserva: false, recebido: '800.00', estornado: '0' },
  ];
  // Cronograma consolidado com itens gravados fora da ordem dos vencimentos (ordem = janeiro antes de dezembro).
  const itens = [
    { id: 'i-jan', parcela_id: 'b-jan', saldo_inicial_centavos: '200000', recebido_base_centavos: '0', estornado_base_centavos: '0', vencimento_referencia: '2027-01-23' },
    { id: 'i-dez', parcela_id: 'c-dez', saldo_inicial_centavos: '200000', recebido_base_centavos: '0', estornado_base_centavos: '0', vencimento_referencia: '2026-12-23' },
  ];
  const tx = { query: async (sql: string) => {
    assert(sql.startsWith('SELECT'), 'leitura jamais escreve');
    let rows: unknown[] = [];
    if (sql.startsWith('SELECT id,fechamento_id')) rows = [{ id: 'c', status: 'ASSINADO', versao_atual: 1 }];
    else if (sql.startsWith('SELECT p.id,p.contrato_versao_id')) rows = [{ id: 'p', contrato_versao_id: 'v', status: 'PARCIAL', valor_total_contratado: '6315.00' }];
    else if (sql.startsWith('SELECT v.id,v.numero_versao')) rows = [versao];
    else if (sql.startsWith('SELECT versao_vigente_id')) rows = [{ versao_vigente_id: 'v' }];
    else if (sql.includes('FROM pagamento_recebimentos WHERE')) rows = [{ id: 'r1', status: 'CONFIRMADO', valor_bruto: '2315.00' }, { id: 'r2', status: 'CONFIRMADO', valor_bruto: '800.00' }];
    else if (sql.startsWith('SELECT pp.id')) rows = parcelas;
    else if (sql.includes('FROM pagamento_planos WHERE')) rows = [{ id: 'pl', status: 'ATIVO', numero_versao: 1 }];
    else if (sql.includes('FROM pagamento_cronogramas WHERE') && cronograma) rows = [{ id: 'cr', estado: 'ATIVO', plano_id: 'pl', saldo_inicial_centavos: '400000' }];
    else if (sql.includes('FROM pagamento_cronograma_itens')) rows = itens;
    return { rows, rowCount: rows.length };
  } };
  const repository = carregar('lib/pagamentos/repositories/alteracao-financeira.repository.ts', {
    '../services/cancelamento-core': { situacaoCobranca }, '../../contratos/services/snapshot-core': { hashSnapshotContrato },
    '../services/alteracao-financeira-core': financeiroCore, '../futuro-ordem': futuroOrdem,
  });
  return await repository.lerPosicaoFinanceira(tx, 'c') as { futuro: Array<{ parcelaId: string; numero: number; vencimento: string; valorCentavos: string }>; parcelas: Array<{ id: string }>; posicao: { saldo: bigint } };
}

for (const cronograma of [false, true]) test(`Theo na leitura do repositório (cronograma=${cronograma}): futuro sai pelos vencimentos e a próxima é 23/12 com R$ 1.200`, async () => {
  const r = await lerTheo(cronograma);
  const esperado = cronograma
    ? [['c-dez', 2, '2026-12-23', '120000'], ['b-jan', 3, '2027-01-23', '200000']]
    : [['a-entrada', 1, '2026-11-23', '0'], ['c-dez', 2, '2026-12-23', '120000'], ['b-jan', 3, '2027-01-23', '200000']];
  // P2 do Astra (24/11): cada item leva o número gravado da parcela. No consolidado a entrada fica fora do cronograma,
  // e dezembro continua sendo a parcela 2 (não a 1ª da lista).
  assert.deepEqual(r.futuro.map((i) => [i.parcelaId, i.numero, i.vencimento, i.valorCentavos]), esperado);
  assert.deepEqual(proximaParcelaEmAberto(r.futuro), { parcelaId: 'c-dez', numero: 2, itemId: cronograma ? 'i-dez' : null, vencimento: '2026-12-23', valorCentavos: '120000' });
  assert.equal(r.posicao.saldo, 320000n, 'saldo total R$ 3.200 = 1.200 + 2.000');
  assert.deepEqual(r.parcelas.map((p) => p.id), ['a-entrada', 'b-jan', 'c-dez'], 'parcelas (e o hash da posição) seguem na ordem lida');
});

test('leitura do repositório: vencimentos iguais saem pelo número gravado da parcela, não pela ordem do id', async () => {
  // b-jan (número 3) é lido antes de c-dez (número 2); com a mesma data, o número decide.
  const r = await lerTheo(false, '2026-12-23');
  assert.deepEqual(r.futuro.map((i) => [i.parcelaId, i.numero]), [['a-entrada', 1], ['c-dez', 2], ['b-jan', 3]]);
});
