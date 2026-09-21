import { NextRequest } from "next/server";
import {
  buscarClientesCrm,
  cadastrarClienteInterno,
  listarClientesCrm,
} from "@/lib/clientes/services";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { contextoCrmDaRequest, exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { clienteCadastroSchema } from "./schemas";

export async function GET(request: NextRequest) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q")?.trim() ?? "";
    const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(searchParams.get("offset") ?? 0) || 0, 0);

    const incluirInativos = searchParams.get("incluirInativos") === "true";
    const data = q
      ? await buscarClientesCrm(q, limit, incluirInativos)
      : await listarClientesCrm({ limit, offset, status: incluirInativos ? "CANONICOS" : "ATIVO" });

    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const body = await request.json();
    const parsed = clienteCadastroSchema.safeParse(body);
    if (!parsed.success) {
      return jsonNoStore(
        { ok: false, erro: "Dados inválidos.", codigo: "DADOS_INVALIDOS", detalhes: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const result = await cadastrarClienteInterno(parsed.data, contextoCrmDaRequest(request));
    return jsonNoStore({ ok: true, data: result }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
