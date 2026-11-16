import type { NextRequest } from "next/server";
import { z } from "zod";
import { FORMAS } from "@/lib/financeiro/calculos";
import { liquidarEntradaManual } from "@/lib/financeiro/escritor-p2";
import { hojeIso } from "@/lib/financeiro/http";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liquidação parcial ou total de entrada manual (P2 fase B). O segmento se chama `parcelaId` porque o Next não aceita dois
 * nomes de slug no mesmo nível; aqui ele é o id da entrada manual. Equipe e Gestão; somente leitura é recusado na sessão.
 * Entrada manual não exige o plano completo (igual à criação em `contas-receber`). Guarda da operação no serviço.
 */
const corpo = z.object({
  valor: z.number().positive(),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  forma: z.enum(FORMAS),
  taxa: z.number().min(0).optional(),
  observacao: z.string().max(500).optional(),
  chave: z.string().min(8).max(160),
}).strict();

export async function POST(request: NextRequest, context: { params: Promise<{ parcelaId: string }> }) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const { parcelaId } = await context.params;
    const entradaId = z.string().uuid().parse(parcelaId);
    const input = corpo.parse(await request.json());
    const hoje = hojeIso();
    const data = await withTenantTransaction(sessao, null, (tx, tenant) =>
      liquidarEntradaManual(tx, tenant.empresaComprovada, tenant.usuarioId, hoje, { ...input, entradaId }));
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
