import { NextRequest } from "next/server";
import { authError } from "@/lib/autenticacao/service";
import { recusarTenantNaoComprovado } from "@/lib/comercial/autorizacao-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    recusarTenantNaoComprovado(sessao, request.nextUrl.searchParams.get("empresaId"));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    if (sessao.papel !== "REPRESENTANTE_AUTORIZADO") throw authError("Apenas o proprietário pode editar pacotes.", 403);
    recusarTenantNaoComprovado(sessao, request.nextUrl.searchParams.get("empresaId"));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
