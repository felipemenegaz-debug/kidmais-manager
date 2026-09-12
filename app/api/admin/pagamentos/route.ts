import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  criarPagamentoDoFechamento,
  obterPagamentoPorFechamento,
} from "@/lib/pagamentos/services";
import { erroPagamentoApi } from "@/lib/http/pagamentos-api";
import { planoPagamentoSchema } from "./schemas";
import {
  contextoCrmDaRequest,
  exigirApiAdminCrmDisponivel,
} from "@/lib/http/admin-crm-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const criarSchema = z.object({
  fechamentoId: z.string().uuid(),
  plano: planoPagamentoSchema,
}).strict();

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: NextRequest) {
  try {
    await exigirApiAdminCrmDisponivel(request);
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
    const data = await obterPagamentoPorFechamento(parsed.data);
    return noStore(NextResponse.json({ ok: true, data }));
  } catch (error) {
    return erroPagamentoApi(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    await exigirApiAdminCrmDisponivel(request);
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
    const data = await criarPagamentoDoFechamento(parsed.data, {
      ...crm,
      origem: "PAGAMENTO_INTERNO_DEV",
    });
    return noStore(NextResponse.json({ ok: true, data }, {
      status: data.reutilizado ? 200 : 201,
    }));
  } catch (error) {
    return erroPagamentoApi(error);
  }
}
