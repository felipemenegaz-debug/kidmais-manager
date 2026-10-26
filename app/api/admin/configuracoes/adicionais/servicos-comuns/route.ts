import { NextRequest } from "next/server";
import { z } from "zod";
import { criarServicosComuns } from "@/lib/comercial/servicos-comuns";
import { exigirGestaoNoTenant, withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Adicionar serviços comuns" (103): só na empresa comprovada, só Gestão, sem preço; idempotente e sem reativar nada. */
export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const { empresaId } = z.object({ empresaId: z.string().uuid().nullable().optional() }).strict().parse(await request.json().catch(() => ({})));
    const data = await withTenantTransaction(sessao, empresaId ?? null, (tx, tenant) => {
      exigirGestaoNoTenant(tenant, "Apenas o proprietário pode editar os adicionais.");
      return criarServicosComuns(tx, { empresaId: tenant.empresaComprovada, usuarioId: sessao.usuario_id, requestId: crypto.randomUUID() });
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
