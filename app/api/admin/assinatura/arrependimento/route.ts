import type { NextRequest } from "next/server";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { jsonNoStore } from "@/lib/http/api-response";
import { contextoDaRequisicao, lerJson } from "@/lib/acessos/http";
import { consultarArrependimento, registrarArrependimento } from "@/lib/assinatura/arrependimento";
import { depsDevolucaoPadrao, responderErroCobranca } from "@/lib/assinatura/cobranca-padrao";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Gestão: se o registro está disponível e as manifestações anteriores (protocolos KA-…). Não consulta o provedor. */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    return jsonNoStore({ ok: true, data: await consultarArrependimento(sessao, request.nextUrl.searchParams.get("empresaId"), depsDevolucaoPadrao()) });
  } catch (error) {
    return responderErroCobranca(error);
  }
}

/** Gestão: registra a manifestação de arrependimento (senha confirmada há no máximo 5 minutos). Não consulta o provedor. */
export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await registrarArrependimento(sessao, request.nextUrl.searchParams.get("empresaId"), await lerJson(request), contextoDaRequisicao(request), depsDevolucaoPadrao());
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return responderErroCobranca(error);
  }
}
