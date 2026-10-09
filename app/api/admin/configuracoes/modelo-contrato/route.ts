import { NextRequest } from "next/server";
import { CAMPOS_CONTRATO, CAMPOS_OBRIGATORIOS } from "@/lib/contratos/modelo-empresa/campos";
import { painelModeloContrato } from "@/lib/contratos/modelo-empresa/servico";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Modelo de contrato da empresa comprovada: ativo, versões, rascunhos e a lista fechada de campos. */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const painel = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), (tx, tenant) =>
      painelModeloContrato(tx, tenant.empresaComprovada));
    return jsonNoStore({
      ok: true,
      data: { ...painel, campos: CAMPOS_CONTRATO.map(({ chave, rotulo, grupo, exemplo }) => ({ chave, rotulo, grupo, exemplo })), obrigatorios: CAMPOS_OBRIGATORIOS },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
