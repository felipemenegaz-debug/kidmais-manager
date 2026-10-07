import type { NextRequest } from "next/server";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { jsonNoStore } from "@/lib/http/api-response";
import { contextoDaRequisicao, lerJson } from "@/lib/acessos/http";
import { cancelarAssinatura } from "@/lib/assinatura/cobranca";
import { depsCobrancaPadrao, responderErroCobranca } from "@/lib/assinatura/cobranca-padrao";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Gestão: cancela ao fim do período pago (senha confirmada há no máximo 5 minutos). */
export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await cancelarAssinatura(sessao, request.nextUrl.searchParams.get("empresaId"), await lerJson(request), contextoDaRequisicao(request), depsCobrancaPadrao());
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return responderErroCobranca(error);
  }
}
