import { NextRequest } from "next/server";
import { z } from "zod";
import { saloesDoDia } from "@/lib/agenda/saloes-do-dia";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 098: ocupação do dia por salão (o combinado ocupado marca os membros). Leitura da empresa comprovada pela sessão.
const consulta = z.object({
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  unidadeId: z.string().uuid().nullable(),
});

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const parametros = request.nextUrl.searchParams;
    const { data, unidadeId } = consulta.parse({ data: parametros.get("data"), unidadeId: parametros.get("unidadeId") || null });
    const saloes = await withTenantTransaction(sessao, parametros.get("empresaId"), (tx, tenant) =>
      saloesDoDia(tx, tenant.empresaComprovada, unidadeId, data));
    return jsonNoStore({ ok: true, data: { saloes } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
