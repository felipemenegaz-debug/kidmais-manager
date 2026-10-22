import test from "node:test";
import assert from "node:assert/strict";
import { carregarModulo } from "../acessos/teste-carregador.ts";

/**
 * Fase 1c: adicionais do fechamento ADMINISTRATIVO (`app/api/admin/fechamentos/adicionais`). A empresa é sempre a
 * comprovada pela sessão; a dona da agenda pública usa só os sete ids V1, as demais também o código do pacote (P_…).
 */
const EMPRESA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LIVRE = "P_9F2C4E1A7B3D4C5E8F6A0B1C2D3E4F5A";

class ErroHttp extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) { super(message); this.code = code; this.httpStatus = httpStatus; }
}

function rota(dona: boolean) {
  const pedidos: Array<Record<string, unknown>> = [];
  const transacoes: Array<string | null> = [];
  const dubles = {
    "next/server": { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) } },
    "lib/http/admin-crm-api": { exigirApiAdminCrmDisponivel: async () => ({ usuario_id: "u1" }) },
    "lib/http/api-response": { apiErrorResponse: (e: { code?: string; httpStatus?: number }) => ({ body: { codigo: e.code }, status: e.httpStatus ?? 500 }) },
    "lib/saas/provar-tenant": {
      withTenantTransaction: async (_s: unknown, empresaId: string | null, fn: (tx: unknown, tenant: unknown) => Promise<unknown>) => {
        transacoes.push(empresaId);
        return fn({}, { empresaComprovada: EMPRESA });
      },
    },
    "lib/disponibilidade/config-legada": { ehDonaDaConfigLegada: async (_tx: unknown, empresa: string) => (assert.equal(empresa, EMPRESA), dona) },
    "lib/comercial/adicionais-tenant": {
      adicionaisDoPacoteNoTenant: async (_tx: unknown, pedido: Record<string, unknown>) => { pedidos.push(pedido); return []; },
    },
    "lib/comercial/pacotes-admin": { PacoteAdminError: ErroHttp },
  };
  const { GET } = carregarModulo("app/api/admin/fechamentos/adicionais/route.ts", dubles, new Map()) as { GET: (r: unknown) => Promise<{ body: Record<string, unknown>; status: number }> };
  const chamar = (pacote: string, empresaId = "") =>
    GET({ nextUrl: new URL(`http://localhost/api/admin/fechamentos/adicionais?pacote=${encodeURIComponent(pacote)}&data=2098-09-12&convidados=40${empresaId ? `&empresaId=${empresaId}` : ""}`) });
  return { chamar, pedidos, transacoes };
}

test("adicionais administrativos — buffet comum: código do pacote dele (P_…) e id V1 traduzido, na empresa comprovada", async () => {
  const r = rota(false);
  assert.equal((await r.chamar(LIVRE)).status, 200);
  assert.equal((await r.chamar("pocket")).status, 200);
  assert.equal((await r.chamar("pizza_party_scienza")).status, 200);
  assert.deepEqual(r.pedidos.map((p) => [p.empresaId, p.pacoteCodigo]), [[EMPRESA, LIVRE], [EMPRESA, "POCKET"], [EMPRESA, "PIZZA_PARTY"]]);
  // Formato inválido: recusado antes de abrir a transação do tenant.
  const antes = r.transacoes.length;
  for (const invalido of ["p_minusculo", "", "../POCKET", "A".repeat(51)]) assert.equal((await r.chamar(invalido)).status, 400, invalido);
  assert.equal(r.transacoes.length, antes);
  assert.equal(r.pedidos.length, 3);
});

test("adicionais administrativos — dona da agenda pública: só os sete ids V1, como antes; código livre recusado", async () => {
  const r = rota(true);
  assert.equal((await r.chamar("pocket")).status, 200);
  assert.equal((await r.chamar("pizza_party_scienza")).status, 200);
  assert.deepEqual(r.pedidos.map((p) => p.pacoteCodigo), ["POCKET", "PIZZA_PARTY"]);
  const livre = await r.chamar(LIVRE);
  assert.equal(livre.status, 400);
  assert.equal(livre.body.codigo, "DADOS_INVALIDOS");
  const codigoV1 = await r.chamar("POCKET");
  assert.equal(codigoV1.status, 400, "dona: o id da tela é o V1, não o código");
  assert.equal(r.pedidos.length, 2);
});
