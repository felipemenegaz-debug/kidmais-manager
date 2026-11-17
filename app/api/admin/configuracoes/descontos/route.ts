import { NextRequest } from "next/server";
import { z } from "zod";
import { lerDescontosAdmin, salvarDescontosAdmin } from "@/lib/comercial/regras-pagamento-admin";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** D1 (16/11/2026): descontos do Pix e nome do cartão da PRÓPRIA empresa. Só a Gestão lê e grava (revalidado no serviço). */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), (tx, tenant) => lerDescontosAdmin(tx, tenant));
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const bruto = await request.json();
    const pedido = z.object({ empresaId: z.string().optional() }).passthrough().parse(bruto);
    // A empresa vem da sessão (provarTenant); o empresaId do corpo só escolhe entre as empresas do próprio usuário.
    const { empresaId: _ignorado, ...resto } = bruto as Record<string, unknown>;
    void _ignorado;
    const data = await withTenantTransaction(sessao, pedido.empresaId, (tx, tenant) =>
      salvarDescontosAdmin(tx, tenant, resto, { requestId: crypto.randomUUID() }));
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
