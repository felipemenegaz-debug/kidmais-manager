import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  criarPagamentoDoFechamento,
  obterPagamentoPorFechamento,
} from "@/lib/pagamentos/services";
import { erroPagamentoApi } from "@/lib/http/pagamentos-api";
import { planoPagamentoSchema, sugestaoPixSchema } from "./schemas";
import {
  contextoCrmDaRequest,
  exigirApiAdminCrmDisponivel,
} from "@/lib/http/admin-crm-api";
import { executarComPosseNoTenant, fechamentoNoTenant } from "@/lib/contratos/services/contrato-tenant";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const criarSchema = z.object({
  fechamentoId: z.string().uuid(),
  plano: z.union([planoPagamentoSchema, sugestaoPixSchema]),
}).strict();

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const parsed = z.string().uuid().safeParse(
      request.nextUrl.searchParams.get("fechamentoId") ?? "",
    );
    if (!parsed.success) {
      return noStore(NextResponse.json({
        ok: false,
        erro: "Informe um fechamentoId válido.",
        codigo: "DADOS_INVALIDOS",
      }, { status: 400 }));
    }
    // C1/C2: posse do fechamento provada no tenant e leitura na MESMA transação. Outra empresa ⇒ 404 igual.
    const data = await executarComPosseNoTenant(sessao, request.nextUrl.searchParams.get("empresaId"), parsed.data, fechamentoNoTenant, { withTenantTransaction }, (tx) => obterPagamentoPorFechamento(parsed.data, tx));
    return noStore(NextResponse.json({ ok: true, data }));
  } catch (error) {
    return erroPagamentoApi(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const body = await request.json().catch(() => null);
    const parsed = criarSchema.safeParse(body);
    if (!parsed.success) {
      return noStore(NextResponse.json({
        ok: false,
        erro: "Dados inválidos para criação do Pagamento.",
        codigo: "DADOS_INVALIDOS",
        detalhes: parsed.error.flatten(),
      }, { status: 400 }));
    }

    const crm = contextoCrmDaRequest(request);
    // C1/C2: tenant + posse do fechamento e criação do pagamento na MESMA transação (executor).
    const data = await executarComPosseNoTenant(sessao, request.nextUrl.searchParams.get("empresaId"), parsed.data.fechamentoId, fechamentoNoTenant, { withTenantTransaction }, (tx) => criarPagamentoDoFechamento(parsed.data, {
      ...crm,
      origem: "PAGAMENTO_INTERNO_DEV",
      executor: tx,
    }));
    if ('sugestao' in data) return noStore(NextResponse.json({
      ok: !data.sugestao.contraproposta, data,
      ...(data.sugestao.contraproposta ? { codigo: 'CONDICAO_PIX_INVIAVEL', erro: data.sugestao.motivo } : {}),
    }, { status: data.sugestao.contraproposta ? 422 : 200 }));
    return noStore(NextResponse.json({ ok: true, data }, {
      status: data.reutilizado ? 200 : 201,
    }));
  } catch (error) {
    return erroPagamentoApi(error);
  }
}
