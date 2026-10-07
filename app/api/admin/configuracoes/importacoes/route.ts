import { NextRequest } from "next/server";
import { listarImportacoes } from "@/lib/comercial/importacao-tabela/servico";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Importações da tabela de preços da empresa (Tenant Context). O envio e a leitura do PDF pela IA ficam em
 * /api/admin/inteligencia/tabela-precos (composition root da IA); aqui só a lista.
 */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), (tx, tenant) =>
      listarImportacoes(tx, tenant.empresaComprovada));
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
