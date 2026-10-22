import type { NextRequest } from "next/server";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { jsonNoStore } from "@/lib/http/api-response";
import { contextoDaRequisicao, lerJson } from "@/lib/acessos/http";
import { consultarEncerramento, solicitarEncerramento } from "@/lib/assinatura/devolucao";
import { depsDevolucaoPadrao, responderErroCobranca } from "@/lib/assinatura/cobranca-padrao";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Gestão: protocolos anteriores; com ?opcoes=1, também as opções de encerramento com devolução (valores calculados agora). */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await consultarEncerramento(sessao, request.nextUrl.searchParams.get("empresaId"), depsDevolucaoPadrao(), request.nextUrl.searchParams.get("opcoes") === "1");
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return responderErroCobranca(error);
  }
}

/** Gestão: arrependimento em 7 dias ou encerramento anual proporcional (senha confirmada há no máximo 5 minutos). */
export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await solicitarEncerramento(sessao, request.nextUrl.searchParams.get("empresaId"), await lerJson(request), contextoDaRequisicao(request), depsDevolucaoPadrao());
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return responderErroCobranca(error);
  }
}
