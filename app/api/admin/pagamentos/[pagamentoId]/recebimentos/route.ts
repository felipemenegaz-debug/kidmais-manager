import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { valorMonetarioSchema } from "../../schemas";
import { erroPagamentoApi } from "@/lib/http/pagamentos-api";
import { registrarRecebimentoPagamento } from "@/lib/pagamentos/services";
import {
  contextoCrmDaRequest,
  tokenAdmin,
  exigirApiAdminCrmDisponivel,
} from "@/lib/http/admin-crm-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  meioPagamento: z.enum(["PIX", "CARTAO", "TRANSFERENCIA", "DINHEIRO", "OUTRO"]),
  valorBruto: valorMonetarioSchema,
  recebidoEm: z.string().datetime({ offset: true }).nullable().optional(),
  provedorCodigo: z.string().trim().max(50).nullable().optional(),
  referenciaExterna: z.string().trim().max(160).nullable().optional(),
  chaveIdempotencia: z.string().trim().min(8).max(160).nullable().optional(),
  metadataProvedor: z.record(z.string(), z.unknown()).optional(),
  observacoes: z.string().trim().max(1000).nullable().optional(),
  confirmarAgora: z.boolean().default(true),
  alocacoes: z.array(z.object({
    parcelaId: z.string().uuid(),
    valor: valorMonetarioSchema,
  }).strict()).min(1).max(60),
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
      return NextResponse.json({ ok: false, erro: "Dados inválidos para o recebimento.", codigo: "DADOS_INVALIDOS", detalhes: parsed.error.flatten() }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const crm = contextoCrmDaRequest(request);
    const data = await registrarRecebimentoPagamento(
      { pagamentoId, ...parsed.data },
      { ...crm, token: tokenAdmin(request), origem: "PAGAMENTO_INTERNO_DEV" },
    );
    const response = NextResponse.json({ ok: true, data }, { status: data.reutilizado ? 200 : 201 });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return erroPagamentoApi(error);
  }
}
