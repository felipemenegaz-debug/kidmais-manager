import type { NextRequest } from "next/server";
import { exigirApiAdminCrmDisponivel } from "../http/admin-crm-api.ts";
import { apiErrorResponse, jsonNoStore } from "../http/api-response.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { withTenantTransaction, type TenantComprovado } from "../saas/provar-tenant.ts";

export function hojeIso() {
  return new Date().toISOString().slice(0, 10);
}

export async function consultarFinanceiro<T>(
  request: NextRequest,
  work: (tx: DbExecutor, tenant: TenantComprovado) => Promise<T>,
) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), work);
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
