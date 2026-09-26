import { NextRequest } from "next/server";
import { recusarTenantNaoComprovado } from "@/lib/comercial/autorizacao-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, _context: RouteContext) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    recusarTenantNaoComprovado(sessao);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
