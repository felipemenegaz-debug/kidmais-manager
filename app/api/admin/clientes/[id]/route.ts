import { NextRequest } from "next/server";
import { z } from "zod";
import { atualizarClienteInterno, obterClienteBase } from "@/lib/clientes/services";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { contextoCrmDaRequest, exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { clientePatchSchema } from "../schemas";

type RouteContext = { params: Promise<{ id: string }> };

async function getParams(context: RouteContext) {
  const params = await Promise.resolve(context.params);
  const id = z.string().uuid().safeParse(params.id);
  if (!id.success) return null;
  return { id: id.data };
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const params = await getParams(context);
    if (!params) {
      return jsonNoStore({ ok: false, erro: "ID de Cliente inválido.", codigo: "DADOS_INVALIDOS" }, { status: 400 });
    }
    const data = await obterClienteBase(params.id);
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const params = await getParams(context);
    if (!params) {
      return jsonNoStore({ ok: false, erro: "ID de Cliente inválido.", codigo: "DADOS_INVALIDOS" }, { status: 400 });
    }
    const body = await request.json();
    const parsed = clientePatchSchema.safeParse(body);
    if (!parsed.success) {
      return jsonNoStore(
        { ok: false, erro: "Dados inválidos.", codigo: "DADOS_INVALIDOS", detalhes: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const data = await atualizarClienteInterno(params.id, parsed.data, contextoCrmDaRequest(request));
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
