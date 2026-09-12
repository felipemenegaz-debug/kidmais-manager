import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { planoPagamentoSchema } from "../../schemas";
import { erroPagamentoApi } from "@/lib/http/pagamentos-api";
import { substituirPlanoPagamento } from "@/lib/pagamentos/services";
import {
  contextoCrmDaRequest,
  exigirApiAdminCrmDisponivel,
} from "@/lib/http/admin-crm-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  motivo: z.string().trim().min(3).max(500),
  plano: planoPagamentoSchema,
}).strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ pagamentoId: string }> },
) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const { pagamentoId } = await context.params;
    if (!z.string().uuid().safeParse(pagamentoId).success) {
      return NextResponse.json({ ok: false, erro: "pagamentoId inválido.", codigo: "DADOS_INVALIDOS" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, erro: "Dados inválidos para alteração do plano.", codigo: "DADOS_INVALIDOS", detalhes: parsed.error.flatten() }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const crm = contextoCrmDaRequest(request);
    const data = await substituirPlanoPagamento(
      pagamentoId,
      parsed.data.plano,
      parsed.data.motivo,
      { ...crm, origem: "PAGAMENTO_INTERNO_DEV" },
    );
    const response = NextResponse.json({ ok: true, data });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return erroPagamentoApi(error);
  }
}
