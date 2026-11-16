import type { NextRequest } from "next/server";
import { z } from "zod";
import { reverterPagamentoConta } from "@/lib/financeiro/escritor-p2";
import { hojeIso } from "@/lib/financeiro/http";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirRecursoPlano } from "@/lib/assinatura/recursos-plano";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reversão de pagamento de conta a pagar (P2 fase B). Equipe e Gestão; plano completo, como o pagamento. */
const corpo = z.object({
  valor: z.number().positive(),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  motivo: z.string().trim().min(3).max(500),
  chave: z.string().min(8).max(160),
}).strict();

export async function POST(request: NextRequest, context: { params: Promise<{ contaId: string; saidaId: string }> }) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const params = await context.params;
    const contaId = z.string().uuid().parse(params.contaId);
    const saidaId = z.string().uuid().parse(params.saidaId);
    const input = corpo.parse(await request.json());
    const hoje = hojeIso();
    const data = await withTenantTransaction(sessao, null, async (tx, tenant) => {
      await exigirRecursoPlano(tx, tenant.empresaComprovada, "FINANCEIRO_COMPLETO");
      return reverterPagamentoConta(tx, tenant.empresaComprovada, tenant.usuarioId, hoje, { ...input, contaId, saidaId });
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
