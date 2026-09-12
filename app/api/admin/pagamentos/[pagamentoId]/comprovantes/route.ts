import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { erroPagamentoApi } from "@/lib/http/pagamentos-api";
import { registrarComprovantePagamento } from "@/lib/pagamentos/services";
import {
  contextoCrmDaRequest,
  exigirApiAdminCrmDisponivel,
} from "@/lib/http/admin-crm-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  recebimentoId: z.string().uuid(),
  nomeArquivo: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(120),
  tamanhoBytes: z.coerce.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  localizadorArquivo: z.string().trim().min(1).max(2000),
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
      return NextResponse.json({ ok: false, erro: "Metadados de comprovante inválidos.", codigo: "DADOS_INVALIDOS", detalhes: parsed.error.flatten() }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const crm = contextoCrmDaRequest(request);
    const data = await registrarComprovantePagamento(
      { pagamentoId, ...parsed.data },
      { ...crm, origem: "PAGAMENTO_INTERNO_DEV" },
    );
    const response = NextResponse.json({ ok: true, data }, { status: data.reutilizado ? 200 : 201 });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return erroPagamentoApi(error);
  }
}
