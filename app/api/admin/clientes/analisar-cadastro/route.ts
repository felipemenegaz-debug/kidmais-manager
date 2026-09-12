import { NextRequest } from "next/server";
import { analisarCadastroCliente } from "@/lib/clientes/services";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { analiseCadastroSchema } from "../schemas";

export async function POST(request: NextRequest) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const body = await request.json();
    const parsed = analiseCadastroSchema.safeParse(body);
    if (!parsed.success) {
      return jsonNoStore(
        { ok: false, erro: "Dados inválidos.", codigo: "DADOS_INVALIDOS", detalhes: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { excluirClienteId, ...input } = parsed.data;
    const result = await analisarCadastroCliente(input, { excluirClienteId });
    return jsonNoStore({ ok: true, data: result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
