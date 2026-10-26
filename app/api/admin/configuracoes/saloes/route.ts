import { NextRequest } from "next/server";
import { apresentacaoInstalada, listarSaloesComApresentacao } from "@/lib/agenda/salao-apresentacao";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Configurações › Salões: salões ativos da empresa comprovada com o resumo da apresentação ao cliente (102). */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), async (tx, tenant) => {
      const instalacao = await apresentacaoInstalada(tx);
      const gestao = tenant.papelAtual === "REPRESENTANTE_AUTORIZADO";
      if (instalacao !== "COMPLETA") return { instalacao, gestao, saloes: [] };
      return { instalacao, gestao, saloes: await listarSaloesComApresentacao(tx, tenant.empresaComprovada) };
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
