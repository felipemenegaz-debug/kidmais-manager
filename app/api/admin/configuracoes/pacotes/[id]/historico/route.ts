import { NextRequest } from "next/server";
import { z } from "zod";
import { historicoPacoteAdmin } from "@/lib/comercial/pacotes-admin";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuid = z.string().uuid();
type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const id = uuid.safeParse((await context.params).id);
    if (!id.success) return jsonNoStore({ ok: false, erro: "Pacote inválido.", codigo: "DADOS_INVALIDOS" }, { status: 400 });
    const data = await withTenantTransaction(
      sessao,
      request.nextUrl.searchParams.get("empresaId"),
      (tx, tenant) => historicoPacoteAdmin(tx, tenant.empresaComprovada, id.data),
    );
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
