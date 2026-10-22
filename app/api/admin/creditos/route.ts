import { after, type NextRequest } from "next/server";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { jsonNoStore } from "@/lib/http/api-response";
import { lerJson } from "@/lib/acessos/http";
import { consultarCreditos } from "@/lib/creditos/servico";
import { criarPedido } from "@/lib/creditos/compra";
import { depsCreditosPadrao, drenarNotificacoesCreditos, responderErroCobranca } from "@/lib/assinatura/cobranca-padrao";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Saldo de créditos de IA (toda a empresa); pedidos, extrato, devoluções e catálogo só para a Gestão. */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await consultarCreditos(sessao, request.nextUrl.searchParams.get("empresaId"), depsCreditosPadrao());
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return responderErroCobranca(error);
  }
}

/** Gestão: novo pedido de pacote (senha confirmada há ≤ 5 min). Preço, quantidade e validade são do servidor. */
export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await criarPedido(sessao, request.nextUrl.searchParams.get("empresaId"), await lerJson(request), depsCreditosPadrao());
    after(() => drenarNotificacoesCreditos());
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return responderErroCobranca(error);
  }
}
