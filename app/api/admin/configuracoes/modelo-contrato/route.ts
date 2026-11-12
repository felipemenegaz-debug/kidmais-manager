import { NextRequest } from "next/server";
import { CAMPOS_CONTRATO, CAMPOS_IDENTIFICACAO, CAMPOS_OBRIGATORIOS } from "@/lib/contratos/modelo-empresa/campos";
import { contratadaEfetiva } from "@/lib/contratos/modelo-empresa/contratada";
import { painelModeloContrato } from "@/lib/contratos/modelo-empresa/servico";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Modelo de contrato da empresa comprovada: ativo, versões, rascunhos e a lista fechada de campos. O conteúdo
 * publicado (com a contratada congelada) é lido por todo o tenant, como antes; a versão ATUAL do perfil, que serve
 * só para o aviso "o perfil mudou", vai apenas para a Gestão (plano modelo de contrato v3, 1.2).
 */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const painel = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), async (tx, tenant) => {
      const dados = await painelModeloContrato(tx, tenant.empresaComprovada);
      const gestao = tenant.papelAtual === "REPRESENTANTE_AUTORIZADO";
      const atual = gestao && dados.ativo ? await contratadaEfetiva(tx, tenant.empresaComprovada, dados.ativo.conteudo) : null;
      return { ...dados, perfilVersaoAtual: atual && atual.estado !== "ERRO" ? atual.perfilVersao : null };
    });
    return jsonNoStore({
      ok: true,
      data: {
        ...painel,
        campos: CAMPOS_CONTRATO.map(({ chave, rotulo, grupo, exemplo }) => ({ chave, rotulo, grupo, exemplo })),
        obrigatorios: CAMPOS_OBRIGATORIOS,
        identificacao: CAMPOS_IDENTIFICACAO,
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
