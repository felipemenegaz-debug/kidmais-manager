import { NextRequest } from "next/server";
import { z } from "zod";
import { historicoPacoteAdmin } from "@/lib/comercial/pacotes-admin";
import { withTransaction } from "@/lib/db/postgres";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuid = z.string().uuid();
type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const id = uuid.safeParse((await context.params).id);
    const empresaId = uuid.safeParse(request.nextUrl.searchParams.get("empresaId"));
    if (!id.success || !empresaId.success) return jsonNoStore({ ok: false, erro: "Pacote ou empresa inválidos.", codigo: "DADOS_INVALIDOS" }, { status: 400 });
    const data = await withTransaction((tx) => historicoPacoteAdmin(tx, empresaId.data, id.data));
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
