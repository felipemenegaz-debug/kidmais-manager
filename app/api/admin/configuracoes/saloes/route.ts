import { NextRequest } from "next/server";
import { apresentacaoInstalada, listarSaloesComApresentacao } from "@/lib/agenda/salao-apresentacao";
import { saloesPublicosLigados } from "@/lib/agenda/salao-publico";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Configurações › Salões: salões ativos da empresa comprovada com o resumo da apresentação ao cliente (102) e se a
 * página pública "Conheça os salões" (S-D) está ligada neste servidor (flag SALOES_PUBLICOS; só o booleano).
 */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), async (tx, tenant) => {
      const instalacao = await apresentacaoInstalada(tx);
      const gestao = tenant.papelAtual === "REPRESENTANTE_AUTORIZADO";
      const paginaPublica = saloesPublicosLigados();
      if (instalacao !== "COMPLETA") return { instalacao, gestao, paginaPublica, saloes: [] };
      return { instalacao, gestao, paginaPublica, saloes: await listarSaloesComApresentacao(tx, tenant.empresaComprovada) };
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
