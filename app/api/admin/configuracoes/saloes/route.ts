import { NextRequest } from "next/server";
import { apresentacaoInstalada, listarSaloesComApresentacao } from "@/lib/agenda/salao-apresentacao";
import { saloesPublicosLigados } from "@/lib/agenda/salao-publico";
import { maisDeUmSalaoLiberado } from "@/lib/agenda/saloes-liberacao-servidor";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Configurações › Salões: salões ativos da empresa comprovada com o resumo da apresentação ao cliente (102) e se a
 * página pública "Conheça os salões" (S-D) está ligada neste servidor (flag SALOES_PUBLICOS; só o booleano).
 * `cadastroNaAgenda`: se a Agenda oferece o cadastro de salões (D-LIB-1: AGENDA_MAIS_DE_UM_SALAO ligada, ou a empresa
 * já tem salões). Desligado e sem salões, a tela não manda o usuário para um cadastro que a Agenda não mostra.
 */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), async (tx, tenant) => {
      const instalacao = await apresentacaoInstalada(tx);
      const gestao = tenant.papelAtual === "REPRESENTANTE_AUTORIZADO";
      const paginaPublica = saloesPublicosLigados();
      if (instalacao !== "COMPLETA") return { instalacao, gestao, paginaPublica, cadastroNaAgenda: maisDeUmSalaoLiberado(), saloes: [] };
      const saloes = await listarSaloesComApresentacao(tx, tenant.empresaComprovada);
      return { instalacao, gestao, paginaPublica, cadastroNaAgenda: maisDeUmSalaoLiberado() || saloes.length > 0, saloes };
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
