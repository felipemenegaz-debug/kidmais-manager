import type { NextRequest } from "next/server";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { jsonNoStore } from "@/lib/http/api-response";
import { consultarPedido } from "@/lib/creditos/compra";
import { depsCreditosPadrao, responderErroCobranca } from "@/lib/assinatura/cobranca-padrao";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Gestão: situação de um pedido da própria empresa pelo protocolo (sem consultar o provedor). */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await consultarPedido(sessao, request.nextUrl.searchParams.get("empresaId"), request.nextUrl.searchParams.get("protocolo"), depsCreditosPadrao());
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return responderErroCobranca(error);
  }
}
