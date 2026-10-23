import { after, type NextRequest } from "next/server";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { jsonNoStore } from "@/lib/http/api-response";
import { lerJson } from "@/lib/acessos/http";
import { solicitarDevolucao } from "@/lib/creditos/devolucao";
import { depsCreditosPadrao, drenarNotificacoesCreditos, responderErroCobranca } from "@/lib/assinatura/cobranca-padrao";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Gestão: devolução de pacote (garantia de 7 dias ou saldo pago não utilizado), com senha recente e protocolo. */
export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await solicitarDevolucao(sessao, request.nextUrl.searchParams.get("empresaId"), await lerJson(request), depsCreditosPadrao());
    after(() => drenarNotificacoesCreditos());
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return responderErroCobranca(error);
  }
}
