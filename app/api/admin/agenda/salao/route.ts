import { NextRequest } from "next/server";
import { z } from "zod";
import { lerSalaoDaFesta, trocarSalaoDaFesta } from "@/lib/agenda/troca-salao";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 094: a equipe da empresa (qualquer membro) troca o salão da festa. O isolamento vem do tenant comprovado e da
// conferência da empresa do fechamento no serviço.
const uuid = z.string().uuid();
const trocar = z.object({ empresaId: z.string().optional(), fechamentoId: uuid, salaoId: uuid }).strict();

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const parametros = request.nextUrl.searchParams;
    const fechamentoId = uuid.parse(parametros.get("fechamentoId"));
    const data = await withTenantTransaction(sessao, parametros.get("empresaId"), (tx, tenant) =>
      lerSalaoDaFesta(tx, tenant.empresaComprovada, fechamentoId));
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const input = trocar.parse(await request.json());
    const data = await withTenantTransaction(sessao, input.empresaId, (tx, tenant) =>
      trocarSalaoDaFesta(
        tx,
        { empresaId: tenant.empresaComprovada, usuarioId: sessao.usuario_id, requestId: crypto.randomUUID() },
        input.fechamentoId,
        input.salaoId,
      ));
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
