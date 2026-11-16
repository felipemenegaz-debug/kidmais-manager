import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { z } from 'zod';
import * as calculos from './calculos.ts';

/**
 * Rota real de contas a pagar com sessão e transação simuladas: o "hoje" entregue a pagarConta vem do relógio do
 * servidor em Brasília, nunca do corpo do pedido.
 */
const ROTA = 'app/api/admin/financeiro/contas-pagar/route.ts';
const CONTA = '44444444-4444-4444-8444-444444444444';
const NOITE_DO_ULTIMO_DIA = new Date('2026-12-01T00:30:00.000Z');

function carregar() {
  const chamadas: unknown[][] = [];
  const exports: Record<string, unknown> = {};
  const js = ts.transpileModule(readFileSync(ROTA, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const deps: Record<string, unknown> = {
    zod: { z },
    '@/lib/financeiro/calculos': calculos,
    '@/lib/financeiro/http': { consultarFinanceiro: async () => new Response(), hojeIso: () => calculos.hojeBrasilia() },
    '@/lib/financeiro/escritor-p2': { operacoesP2: () => ({ liquidacao: false, reversao: false, abertura: false }) },
    '@/lib/financeiro/servico': {
      cancelarConta: async () => undefined, criarContaPagar: async () => 'id', editarContaPagar: async () => undefined,
      listarContasPagar: async () => [], pagoNoPeriodo: async () => 0,
      pagarConta: async (...args: unknown[]) => { chamadas.push(args); return { reutilizado: false, id: 'saida' }; },
    },
    '@/lib/http/api-response': {
      apiErrorResponse: () => new Response(JSON.stringify({ ok: false }), { status: 400 }),
      jsonNoStore: (corpo: unknown) => new Response(JSON.stringify(corpo)),
    },
    '@/lib/http/admin-crm-api': { exigirApiAdminCrmDisponivel: async () => ({ usuario_id: 'u1' }) },
    '@/lib/saas/provar-tenant': {
      withTenantTransaction: async (_s: unknown, _e: unknown, work: (tx: unknown, t: unknown) => Promise<unknown>) =>
        work({}, { usuarioId: 'u1', empresaComprovada: 'empresa' }),
    },
    '@/lib/assinatura/recursos-plano': { exigirRecursoPlano: async () => undefined },
  };
  new Function('require', 'exports', js)((id: string) => { assert(id in deps, `Dependência não simulada: ${id}`); return deps[id]; }, exports);
  return { POST: exports.POST as (pedido: unknown) => Promise<Response>, chamadas };
}

const corpo = { acao: 'pagar', contaId: CONTA, valor: 10, data: '2026-11-30', forma: 'PIX', chave: 'chave-pagamento' };
const pedido = (dados: unknown) => ({ json: async () => dados });

test('a rota entrega a pagarConta o dia de Brasília, mesmo com UTC já no dia seguinte', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOITE_DO_ULTIMO_DIA });
  const { POST, chamadas } = carregar();
  const resposta = await POST(pedido(corpo));
  assert.equal(resposta.status, 200);
  assert.equal(chamadas.length, 1);
  const [, empresa, ator, hoje, input] = chamadas[0];
  assert.deepEqual([empresa, ator, hoje], ['empresa', 'u1', '2026-11-30']);
  assert.equal((input as { data: string }).data, '2026-11-30');
});

test('o corpo do pedido não consegue informar o "hoje"', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOITE_DO_ULTIMO_DIA });
  const { POST, chamadas } = carregar();
  const resposta = await POST(pedido({ ...corpo, data: '2027-01-01', hoje: '2027-01-01' }));
  assert.equal(resposta.status, 400);
  assert.equal(chamadas.length, 0);
});
