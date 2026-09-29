import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { erroPagamentoApi } from "@/lib/http/pagamentos-api";
import { registrarComprovantePagamento } from "@/lib/pagamentos/services";
import {
  contextoCrmDaRequest,
  exigirApiAdminCrmDisponivel,
} from "@/lib/http/admin-crm-api";
import { executarComPosseNoTenant, pagamentoNoTenant } from "@/lib/contratos/services/contrato-tenant";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";

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
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const { pagamentoId } = await context.params;
    if (!z.string().uuid().safeParse(pagamentoId).success) {
      return NextResponse.json({ ok: false, erro: "pagamentoId inválido.", codigo: "DADOS_INVALIDOS" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, erro: "Metadados de comprovante inválidos.", codigo: "DADOS_INVALIDOS", detalhes: parsed.error.flatten() }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const crm = contextoCrmDaRequest(request);
    // C1/C2: tenant (usuário, empresa, membership, papel atual) + posse, com as travas até o commit, e a
    // leitura/escrita na MESMA transação (executor). Outra empresa, legado ou inexistente ⇒ 404 igual.
    const data = await executarComPosseNoTenant(sessao, request.nextUrl.searchParams.get("empresaId"), pagamentoId, pagamentoNoTenant, { withTenantTransaction }, (tx) => registrarComprovantePagamento(
      { pagamentoId, ...parsed.data },
      { ...crm, origem: "PAGAMENTO_INTERNO_DEV", executor: tx },
    ));
    const response = NextResponse.json({ ok: true, data }, { status: data.reutilizado ? 200 : 201 });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return erroPagamentoApi(error);
  }
}
