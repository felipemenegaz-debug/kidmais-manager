import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as core from './financeiro-core.ts';
import { distribuirCentavos } from './alteracao-financeira-core.ts';
import { PagamentoServiceError } from './errors.ts';
import { hashSnapshotContrato } from '../../contratos/services/snapshot-core.ts';
import type { CriarPagamentoInput, PlanoPagamentoInput, PagamentoDetalhe } from './models';

// Exercita o serviço real com repositórios em memória; nenhum pool/credencial é carregado.
function servico(existente = false) {
  const escritas: string[] = [];
  const snapshot = { evento: { data: '2027-06-15' }, comercial: { valorFinalContrato: 9700 } };
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
  return { criar, substituir, escritas };
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
