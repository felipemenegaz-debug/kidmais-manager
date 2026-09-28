import { NextRequest } from "next/server";
import { analisarCadastroCliente } from "@/lib/clientes/services";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { analiseCadastroSchema } from "../schemas";

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const body = await request.json();
    const parsed = analiseCadastroSchema.safeParse(body);
    if (!parsed.success) {
      return jsonNoStore(
        { ok: false, erro: "Dados inválidos.", codigo: "DADOS_INVALIDOS", detalhes: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { excluirClienteId, ...input } = parsed.data;
    const result = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), (tx, tenant) =>
      analisarCadastroCliente(input, tenant.empresaComprovada, { excluirClienteId }, tx));
    return jsonNoStore({ ok: true, data: result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
