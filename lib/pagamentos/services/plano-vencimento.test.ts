import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as core from './financeiro-core.ts';
import { distribuirCentavos } from './alteracao-financeira-core.ts';
import { sugerirParcelamentoPix } from './sugestao-pix.ts';
import { PagamentoServiceError } from './errors.ts';
import { hashSnapshotContrato } from '../../contratos/services/snapshot-core.ts';
import type { CriarPagamentoInput, SugerirPagamentoInput, SugestaoPagamentoResult, PlanoPagamentoInput, PagamentoDetalhe } from './models';

// Exercita o serviço real com repositórios em memória; nenhum pool/credencial é carregado.
function servico(existente = false, forma = 'PIX_PARCELADO') {
  const escritas: string[] = [];
  const snapshot = { evento: { data: '2027-06-15' }, comercial: { valorFinalContrato: 9700, formaPagamentoPretendida: forma } };
  const versao = { id: 'v', contratoId: 'c', status: 'ASSINADA', assinadoEm: '2026-09-20', numeroVersao: 1,
    snapshot, snapshotHash: hashSnapshotContrato(snapshot) };
  const contrato = { id: 'c', fechamentoId: 'f', status: 'ASSINADO', versaoAtual: 1 };
  // Data divergente prova que o limite vem da versão assinada, não do fechamento mutável.
  const fechamento = { id: 'f', clienteId: 'cliente', status: 'CONTRATO_ASSINADO', dataEvento: '2027-12-31' };
  const pagamento = { id: 'p', contratoVersaoId: 'v', valorTotalContratado: 9700, status: 'AGUARDANDO_PAGAMENTO', reservaStatus: 'PENDENTE' };
  let plano: Record<string, unknown> = { id: 'pl', numeroVersao: 1 };
  let parcelas: Record<string, unknown>[] = [];
  let temPagamento = existente;
  const movimento = { recebidoConfirmado: 0, estornadoConfirmado: 0 };
  const tx = { query: () => { throw Error('SQL inesperado em teste sem banco'); } };
  const deps: Record<string, unknown> = {
    './financeiro-core': core,
    './sugestao-pix': { sugerirParcelamentoPix },
    './errors': { PagamentoServiceError },
    '../../contratos/services/snapshot-core': { hashSnapshotContrato },
    '../../db/postgres': { withTransaction: async (fn: (tx: unknown) => unknown) => fn(tx) },
    '../../fechamentos/services/revisao-operacional.service': { revisaoAbertaDoFechamento: async () => null },
    '../../contratos/repositories': {
      buscarContratoPorFechamentoId: async () => contrato, buscarContratoPorId: async () => contrato,
      buscarVersaoCorrente: async () => versao, buscarVersaoPorId: async () => versao,
    },
    '../../fechamentos/repositories': {
      buscarFechamentoPorIdParaAtualizacao: async () => fechamento,
      marcarFechamentoAguardandoPagamento: async () => { escritas.push('fechamento'); return fechamento; },
    },
    '../../clientes/repositories': {
      registrarAuditoria: async () => escritas.push('auditoria'), registrarEventoHistorico: async () => escritas.push('historico'),
    },
    './movimentos-consolidados': { possuiCronograma: async () => false },
    '../repositories': {
      buscarPagamentoPorContratoVersaoId: async () => temPagamento ? pagamento : null,
      buscarPagamentoPorFechamentoId: async () => temPagamento ? pagamento : null,
      buscarPagamentoPorId: async () => pagamento,
      criarPagamento: async () => { escritas.push('pagamento'); temPagamento = true; return pagamento; },
      criarPlanoPagamento: async (input: Record<string, unknown>) => { escritas.push('plano'); parcelas = []; plano = { id: 'pl', ...input }; return plano; },
      criarParcelaPagamento: async (input: Record<string, unknown>) => {
        escritas.push('parcela'); const p = { id: String(parcelas.length), status: 'PENDENTE', ...input }; parcelas.push(p); return p;
      },
      buscarPlanoAtivo: async () => plano, listarParcelasPlano: async () => parcelas,
      resumoMovimentosParcelas: async () => [], resumoMovimentosPagamento: async () => movimento,
      existeRecebimentoPagamento: async () => false,
      substituirPlanoAtivo: async () => escritas.push('substituir'), cancelarParcelasPendentesDoPlano: async () => escritas.push('cancelar'),
    },
  };
  const exports: Record<string, unknown> = {};
  const js = ts.transpileModule(readFileSync('lib/pagamentos/services/pagamento.service.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'exports', js)((id: string) => deps[id] ?? {}, exports);
  const criar = exports.criarPagamentoDoFechamento as (input: CriarPagamentoInput, ctx: object) => Promise<{ detalhe: PagamentoDetalhe; reutilizado: boolean }>;
  const substituir = exports.substituirPlanoPagamento as (id: string, input: PlanoPagamentoInput, motivo: string, ctx: object) => Promise<PagamentoDetalhe>;
  const automatico = exports.criarPagamentoDoFechamento as (input: SugerirPagamentoInput, ctx: object) => Promise<{ detalhe: PagamentoDetalhe; reutilizado: boolean } | SugestaoPagamentoResult>;
  return { criar, automatico, substituir, escritas, snapshot, versao };
}

function plano(vencimento: string, gerado = false): PlanoPagamentoInput {
  const valores = gerado ? distribuirCentavos(770000n, 3).map(v => Number(v) / 100) : [7700];
  return { meioPagamento: 'PIX', modalidade: 'PARCELADO', parcelas: [
    { valor: 2000, vencimento: '2026-10-05', confirmaReserva: true },
    ...valores.map((valor, i) => ({ valor, vencimento: i === valores.length - 1 ? vencimento : '2027-01-05' })),
  ] };
}

for (const gerado of [false, true]) {
  for (const vencimento of ['2027-06-14', '2027-06-15', '2027-06-16']) {
    test(`criação inicial ${gerado ? 'parcelas geradas' : 'plano explícito'}: ${vencimento}`, async () => {
      const s = servico(), input = { fechamentoId: 'f', plano: plano(vencimento, gerado) };
      if (vencimento > '2027-06-15') {
        await assert.rejects(s.criar(input, { origem: 'TESTE' }), { code: 'PIX_APOS_DATA_FESTA', status: 422 });
        assert.deepEqual(s.escritas, [], 'recusa antes de obrigação, plano, parcelas ou histórico');
      } else {
        const r = await s.criar(input, { origem: 'TESTE' });
        assert.equal(r.detalhe.totais.saldo, 9700, 'entrada prevista não é recebimento');
        assert.equal(r.detalhe.totais.recebidoConfirmado, 0);
        assert.equal(r.detalhe.parcelas.reduce((sum, p) => sum + core.dinheiroParaCentavos(p.valorPrevisto), 0), 970000);
        const escritas = [...s.escritas];
        assert.equal((await s.criar(input, { origem: 'TESTE' })).reutilizado, true);
        assert.deepEqual(s.escritas, escritas, 'repetição não cria novos fatos');
        await assert.rejects(s.criar({ ...input, plano: plano('2027-06-16', gerado) }, { origem: 'TESTE' }), { code: 'PIX_APOS_DATA_FESTA' });
        assert.deepEqual(s.escritas, escritas);
      }
    });
  }
}

for (const vencimento of ['2027-06-15', '2027-06-16']) test(`substituição de plano original: ${vencimento}`, async () => {
  const s = servico(true);
  const executar = () => s.substituir('p', plano(vencimento), 'Teste de prazo', { origem: 'TESTE' });
  if (vencimento > '2027-06-15') {
    await assert.rejects(executar(), { code: 'PIX_APOS_DATA_FESTA' });
    assert.deepEqual(s.escritas, [], 'não substitui/cancela plano anterior na recusa');
  } else {
    const r = await executar();
    assert.equal(r.parcelas.length, 2);
    assert(s.escritas.includes('substituir'));
  }
});

const contextoAdmin = { origem: 'TESTE', usuarioId: 'admin' };
const automatico = (pedido = {}): SugerirPagamentoInput => ({ fechamentoId: 'f', plano: { meioPagamento: 'PIX', modalidade: 'PARCELADO', ...pedido } });
for (const pedido of [{ entrada: 2000, valorParcela: 3000 }, { valorParcela: 100 }, { quantidadeParcelas: 99 }, { valorParcela: 1000, quantidadeParcelas: 2 }, {}]) {
  test(`sugestão/contraproposta só grava após confirmação e retry não duplica: ${JSON.stringify(pedido)}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 20, 15) });
    const s = servico(), input = automatico(pedido);
    const preview = await s.automatico(input, contextoAdmin);
    assert('sugestao' in preview); assert.equal(preview.exigeConfirmacao, true);
    assert.deepEqual(s.escritas, [], 'nenhuma escrita durante a sugestão, inclusive inviável');
    const confirmado: SugerirPagamentoInput = { ...input, plano: { ...input.plano, confirmacao: { hash: preview.sugestao.hash, dataReferencia: preview.sugestao.dataReferencia } } };
    const salvo = await s.automatico(confirmado, contextoAdmin);
    assert('detalhe' in salvo); assert.equal(salvo.detalhe.totais.saldo, 9700);
    assert.equal(salvo.detalhe.totais.recebidoConfirmado, 0);
    assert.deepEqual(salvo.detalhe.parcelas.map(p => [p.valorPrevisto, p.vencimento]), preview.sugestao.plano.parcelas.map(p => [p.valor, p.vencimento]));
    const escritas = [...s.escritas];
    t.mock.timers.setTime(Date.UTC(2026, 8, 21, 15));
    const retry = await s.automatico(confirmado, contextoAdmin);
    assert('detalhe' in retry); assert.equal(retry.reutilizado, true);
    assert.deepEqual(s.escritas, escritas, 'retry no dia seguinte mantém o plano já confirmado');
  });
}
test('confirmação adulterada, pedido alterado ou dia diferente recusam sem persistência', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 20, 15) });
  const s = servico(), input = automatico({ entrada: 2000 });
  const preview = await s.automatico(input, contextoAdmin); assert('sugestao' in preview);
  const confirmacao = { hash: preview.sugestao.hash, dataReferencia: preview.sugestao.dataReferencia };
  for (const plano of [
    { ...input.plano, confirmacao: { ...confirmacao, hash: '0'.repeat(64) } },
    { ...input.plano, entrada: 1000, confirmacao },
    { ...input.plano, confirmacao: { ...confirmacao, dataReferencia: '2026-09-19' } },
  ]) await assert.rejects(s.automatico({ ...input, plano }, contextoAdmin), { code: 'SUGESTAO_PIX_DESATUALIZADA' });
  s.snapshot.evento.data = '2027-06-10'; s.versao.snapshotHash = hashSnapshotContrato(s.snapshot);
  await assert.rejects(s.automatico({ ...input, plano: { ...input.plano, confirmacao } }, contextoAdmin), { code: 'SUGESTAO_PIX_DESATUALIZADA' });
  assert.deepEqual(s.escritas, []);
});
test('sugestão exige ator administrativo e não muda cartão ou PIX à vista', async () => {
  for (const forma of ['CARTAO_CIELO', 'PIX_AVISTA']) {
    const s = servico(false, forma);
    await assert.rejects(s.automatico(automatico(), contextoAdmin), { code: 'SUGESTAO_PIX_NAO_PERMITIDA' });
    assert.deepEqual(s.escritas, []);
  }
  const s = servico();
  await assert.rejects(s.automatico(automatico(), { origem: 'TESTE' }), { code: 'SUGESTAO_PIX_NAO_PERMITIDA' });
  assert.deepEqual(s.escritas, []);
});
