import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { z } from 'zod';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';
import * as calculos from './calculos.ts';
import * as idempotencia from './idempotencia.ts';
import * as servico from './servico.ts';

/**
 * Baixa de recebimento pela rota e pelo serviço reais, com sessão, banco e motor simulados. A data civil é comparada
 * ao dia de Brasília: das 21:00 às 23:59 o motor, sozinho, ainda aceitaria amanhã (meia-noite UTC já passou).
 */
const PARCELA = '55555555-5555-4555-8555-555555555555';
const TENANT = { empresaComprovada: 'empresa', usuarioId: 'u1' };

function transpilar(arquivo: string, deps: Record<string, unknown>) {
  const exports: Record<string, unknown> = {};
  const js = ts.transpileModule(readFileSync(arquivo, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'exports', js)((id: string) => { assert(id in deps, `Dependência não simulada: ${id}`); return deps[id]; }, exports);
  return exports;
}

function carregarServico(prepararBaixa: (...args: unknown[]) => unknown) {
  const motor: unknown[] = [];
  const modulo = transpilar('lib/financeiro/baixa.ts', {
    '../comercial/pacotes-admin.ts': { PacoteAdminError },
    '../pagamentos/services/pagamento.service.ts': {
      registrarRecebimentoPagamento: async (input: unknown) => { motor.push(input); return { reutilizado: false }; },
    },
    './calculos.ts': calculos,
    './idempotencia.ts': idempotencia,
    './servico.ts': { prepararBaixa, auditarRecebimento: async () => undefined },
  });
  return { baixar: modulo.baixarRecebimentoNoTenant as (...args: unknown[]) => Promise<{ reutilizado: boolean }>, motor };
}

const pedido = { parcelaId: PARCELA, valor: 10, data: '2026-12-20', forma: 'PIX', chave: 'chave-recebimento' };
const contexto = { token: 't', usuarioId: 'u1', origem: 'financeiro', requestId: 'r' };

test('a chave já gravada é devolvida antes de julgar a data, mesmo com data futura antiga', async () => {
  const linha = {
    empresa_id: 'empresa', bruto: '10.00', meio: 'PIX', metadata: { forma: 'PIX', taxaCentavos: 0 }, parcela_id: PARCELA, alocado: '10.00', data: '2026-12-20', observacao: null,
  };
  const tx = { query: async () => ({ rows: [linha], rowCount: 1 }) };
  const { baixar, motor } = carregarServico(() => { throw new Error('não preparar baixa repetida'); });
  const repetida = await baixar(tx, TENANT, '2026-11-30', pedido, contexto);
  assert.equal(repetida.reutilizado, true);
  assert.equal(motor.length, 0);
});

test('baixa nova passa o dia recebido à preparação e só chega ao motor depois dela', async () => {
  const tx = { query: async () => ({ rows: [], rowCount: 0 }) };
  const preparos: unknown[][] = [];
  const pronta = { pagamentoId: 'p', parcelaId: PARCELA, valorReais: 10, taxa: 0, liquidoCentavos: 1000, meio: 'PIX' };

  const aceita = carregarServico((...args) => { preparos.push(args); return pronta; });
  await aceita.baixar(tx, TENANT, '2026-11-30', { ...pedido, data: '2026-11-29' }, contexto);
  assert.equal(preparos[0][2], '2026-11-30');
  assert.equal((aceita.motor[0] as { recebidoEm: string }).recebidoEm, '2026-11-29T00:00:00.000Z');

  const recusa = carregarServico(() => { throw new PacoteAdminError('DADOS_INVALIDOS', 'futura', 409); });
  await assert.rejects(() => recusa.baixar(tx, TENANT, '2026-11-30', pedido, contexto), /futura/);
  assert.equal(recusa.motor.length, 0);
});

function carregarRota() {
  const chamadas: unknown[][] = [];
  const modulo = transpilar('app/api/admin/financeiro/contas-receber/route.ts', {
    zod: { z },
    '@/lib/financeiro/calculos': calculos,
    '@/lib/financeiro/http': { consultarFinanceiro: async () => new Response(), hojeIso: () => calculos.hojeBrasilia() },
    '@/lib/financeiro/baixa': { baixarRecebimentoNoTenant: async (...args: unknown[]) => { chamadas.push(args); return { reutilizado: false, liquidoCentavos: 1000 }; } },
    '@/lib/financeiro/escritor-p2': { operacoesP2: () => ({ liquidacao: false, reversao: false, abertura: false }) },
    '@/lib/financeiro/servico': { criarEntradaManual: async () => ({}), listarRecebiveis: async () => [], resumo: () => ({}), recebidoNoMes: async () => 0 },
    '@/lib/http/api-response': {
      apiErrorResponse: () => new Response(JSON.stringify({ ok: false }), { status: 400 }),
      jsonNoStore: (corpo: unknown) => new Response(JSON.stringify(corpo)),
    },
    '@/lib/http/admin-crm-api': { contextoCrmDaRequest: () => ({}), exigirApiAdminCrmDisponivel: async () => ({ usuario_id: 'u1' }), tokenAdmin: () => 't' },
    '@/lib/saas/provar-tenant': { withTenantTransaction: async (_s: unknown, _e: unknown, work: (tx: unknown, t: unknown) => Promise<unknown>) => work({}, TENANT) },
  });
  return { POST: modulo.POST as (pedido: unknown) => Promise<Response>, chamadas };
}

for (const [rotulo, instante] of [['21:00:00', '2026-12-01T00:00:00.000Z'], ['23:59:59', '2026-12-01T02:59:59.000Z']] as const) {
  test(`às ${rotulo} de Brasília a rota entrega o dia 30/11 como hoje, não o dia UTC`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(instante) });
    const { POST, chamadas } = carregarRota();
    const resposta = await POST({ json: async () => ({ ...pedido, data: '2026-12-01' }) });
    assert.equal(resposta.status, 200);
    assert.equal(chamadas[0][2], '2026-11-30');
  });
}

test('o corpo do pedido não consegue informar o "hoje"', async () => {
  const { POST, chamadas } = carregarRota();
  const resposta = await POST({ json: async () => ({ ...pedido, hoje: '2027-01-01' }) });
  assert.equal(resposta.status, 400);
  assert.equal(chamadas.length, 0);
});

/** Só sessão, transação e banco são simulados: rota, hojeIso, baixa, prepararBaixa e resposta de erro são os reais. */
function carregarCadeiaReal() {
  const motor: unknown[] = [];
  class Vazia extends Error {}
  const nunca = () => false;
  const NextResponse = {
    json: (corpo: unknown, init?: ResponseInit) => new Response(JSON.stringify(corpo), init),
  };
  const apiResponse = transpilar('lib/http/api-response.ts', {
    'next/server': { NextResponse },
    zod: { ZodError: z.ZodError },
    '../clientes/services': { isClienteServiceError: nunca },
    '../contratos/services/errors': { isContratoServiceError: nunca },
    '../fechamentos/services/errors': { FechamentoServiceError: Vazia },
    '../comercial/services/errors': { PricingServiceError: Vazia },
    '../disponibilidade/services/errors': { AvailabilityServiceError: Vazia },
    '../comercial/condicao-pagamento': { CondicaoPagamentoError: Vazia },
    '../comercial/pacotes-admin': { PacoteAdminError },
    '../pagamentos/services/errors': { isPagamentoServiceError: nunca },
    '../contratos/services/resumo-tenant': { ResumoTenantError: Vazia },
    '../marketing/erros': { MarketingError: Vazia, schemaAusente: () => null },
  });
  const sessao = { exigirApiAdminCrmDisponivel: async () => ({ usuario_id: 'u1' }) };
  const tenant = {
    withTenantTransaction: async (_s: unknown, _e: unknown, work: (tx: unknown, t: unknown) => Promise<unknown>) =>
      work({ query: async () => ({ rows: [], rowCount: 0 }) }, TENANT),
  };
  const http = transpilar('lib/financeiro/http.ts', {
    '../comercial/pacotes-admin.ts': { PacoteAdminError },
    './calculos.ts': calculos,
    '../http/admin-crm-api.ts': sessao,
    '../http/api-response.ts': apiResponse,
    '../assinatura/recursos-plano.ts': { exigirRecursoPlano: async () => undefined },
    '../saas/provar-tenant.ts': tenant,
  });
  const baixa = transpilar('lib/financeiro/baixa.ts', {
    '../comercial/pacotes-admin.ts': { PacoteAdminError },
    '../pagamentos/services/pagamento.service.ts': {
      registrarRecebimentoPagamento: async (input: unknown) => { motor.push(input); return { reutilizado: false }; },
    },
    './calculos.ts': calculos,
    './idempotencia.ts': idempotencia,
    './servico.ts': servico,
  });
  const rota = transpilar('app/api/admin/financeiro/contas-receber/route.ts', {
    zod: { z },
    '@/lib/financeiro/calculos': calculos,
    '@/lib/financeiro/http': http,
    '@/lib/financeiro/baixa': baixa,
    '@/lib/financeiro/escritor-p2': { operacoesP2: () => ({ liquidacao: false, reversao: false, abertura: false }) },
    '@/lib/financeiro/servico': servico,
    '@/lib/http/api-response': apiResponse,
    '@/lib/http/admin-crm-api': { ...sessao, contextoCrmDaRequest: () => ({}), tokenAdmin: () => 't' },
    '@/lib/saas/provar-tenant': tenant,
  });
  return { POST: rota.POST as (pedido: unknown) => Promise<Response>, motor };
}

const FRONTEIRAS = [
  { rotulo: '20:59:59.999 de 30/11', instante: '2026-11-30T23:59:59.999Z', hoje: '2026-11-30', amanha: '2026-12-01' },
  { rotulo: '21:00:00.000 de 30/11', instante: '2026-12-01T00:00:00.000Z', hoje: '2026-11-30', amanha: '2026-12-01' },
  { rotulo: '23:59:59.999 de 30/11', instante: '2026-12-01T02:59:59.999Z', hoje: '2026-11-30', amanha: '2026-12-01' },
  { rotulo: '00:00:00.000 de 01/12', instante: '2026-12-01T03:00:00.000Z', hoje: '2026-12-01', amanha: '2026-12-02' },
];

for (const { rotulo, instante, hoje, amanha } of FRONTEIRAS) {
  test(`cadeia real às ${rotulo} de Brasília: amanhã dá 409 sem chegar ao motor; hoje passa da guarda`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(instante) });
    const { POST, motor } = carregarCadeiaReal();

    const recusada = await POST({ json: async () => ({ ...pedido, data: amanha }) });
    const corpo = await recusada.json() as { codigo: string; erro: string };
    assert.equal(recusada.status, 409);
    assert.equal(corpo.codigo, 'DADOS_INVALIDOS');
    assert.match(corpo.erro, /não pode ser futura/);
    assert.equal(motor.length, 0);

    // Sem parcela no banco simulado: passar da data leva à recusa seguinte, de parcela não encontrada.
    const aceita = await POST({ json: async () => ({ ...pedido, data: hoje }) });
    assert.equal(aceita.status, 404);
    assert.equal((await aceita.json() as { codigo: string }).codigo, 'NAO_ENCONTRADO');
  });
}
