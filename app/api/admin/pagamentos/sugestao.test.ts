import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { z } from 'zod';
import { centavosComerciais } from '../../../../lib/comercial/condicao-pagamento.ts';

function carregar(path: string, deps: Record<string, unknown>) {
  const exports: Record<string, unknown> = {};
  const js = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'exports', js)((id: string) => {
    assert(id in deps, `Dependência não simulada: ${id}`); return deps[id];
  }, exports);
  return exports;
}
const comercial = carregar('lib/http/condicao-pagamento-schema.ts', { zod: { z }, '../comercial/condicao-pagamento': { centavosComerciais } });
const schemas = carregar('app/api/admin/pagamentos/schemas.ts', { zod: { z }, '@/lib/http/condicao-pagamento-schema': comercial });
const fechamentoId = '00000000-0000-4000-8000-000000000001';
const pedido = { meioPagamento: 'PIX', modalidade: 'PARCELADO', entrada: '2000.00', valorParcela: '3000.00' };
function api(resultado: object) {
  const chamadas: unknown[] = [];
  const route = carregar('app/api/admin/pagamentos/route.ts', {
    'next/server': { NextResponse: { json: (body: unknown, init: ResponseInit) => new Response(JSON.stringify(body), init) } },
    zod: { z }, './schemas': schemas,
    '@/lib/pagamentos/services': { criarPagamentoDoFechamento: async (body: unknown, ctx: { usuarioId: string }) => {
      assert.equal(ctx.usuarioId, 'admin'); chamadas.push(body); return resultado;
    } },
    '@/lib/http/admin-crm-api': { exigirApiAdminCrmDisponivel: async () => {}, contextoCrmDaRequest: () => ({ usuarioId: 'admin' }) },
    '@/lib/http/pagamentos-api': { erroPagamentoApi: (e: unknown) => { throw e; } },
  });
  const post = route.POST as (request: { json: () => Promise<unknown> }) => Promise<Response>;
  return { enviar: (plano: object) => post({ json: async () => ({ fechamentoId, plano }) }), chamadas };
}
for (const contraproposta of [false, true]) test(`API retorna sugestão sem persistência, contraproposta=${contraproposta}`, async () => {
  const data = { sugestao: { contraproposta, motivo: contraproposta ? 'Prazo insuficiente' : null, hash: 'a'.repeat(64) }, exigeConfirmacao: true };
  const a = api(data), response = await a.enviar(pedido), body = await response.json();
  assert.equal(response.status, contraproposta ? 422 : 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(body.data.exigeConfirmacao, true);
  assert.equal(body.codigo, contraproposta ? 'CONDICAO_PIX_INVIAVEL' : undefined);
});
for (const reutilizado of [false, true]) test(`API encaminha confirmação explícita e informa replay=${reutilizado}`, async () => {
  const a = api({ detalhe: { pagamento: { id: 'p' } }, reutilizado });
  const plano = { ...pedido, confirmacao: { dataReferencia: '2026-09-20', hash: 'a'.repeat(64) } };
  assert.equal((await a.enviar(plano)).status, reutilizado ? 200 : 201);
  assert.deepEqual(a.chamadas, [{ fechamentoId, plano }]);
});
test('API mantém plano explícito de cartão e PIX', async () => {
  for (const meioPagamento of ['PIX', 'CARTAO']) {
    const a = api({ detalhe: {}, reutilizado: false });
    assert.equal((await a.enviar({ meioPagamento, modalidade: 'PARCELADO', parcelas: [
      { valor: 2000, vencimento: '2026-09-20', confirmaReserva: true },
      { valor: 7700, vencimento: '2027-06-15' },
    ] })).status, 201);
  }
});
test('payload ambíguo, confirmação inválida e sugestão de cartão não chegam ao serviço', async () => {
  const a = api({});
  for (const plano of [
    { ...pedido, parcelas: [] }, { ...pedido, meioPagamento: 'CARTAO' },
    { ...pedido, confirmacao: true }, { ...pedido, valorParcela: '1.001' },
    { ...pedido, dataReferencia: '2020-01-01' }, { ...pedido, valorFinalContrato: 1 },
  ]) assert.equal((await a.enviar(plano)).status, 400);
  assert.deepEqual(a.chamadas, []);
});
