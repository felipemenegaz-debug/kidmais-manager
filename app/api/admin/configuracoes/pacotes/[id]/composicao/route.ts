import { NextRequest } from "next/server";
import { authError } from "@/lib/autenticacao/service";
import { recusarTenantNaoComprovado } from "@/lib/comercial/autorizacao-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    if (sessao.papel !== "REPRESENTANTE_AUTORIZADO") throw authError("Apenas o proprietário pode editar a composição.", 403);
    recusarTenantNaoComprovado(sessao);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
