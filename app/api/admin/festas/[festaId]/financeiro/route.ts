import type { NextRequest } from "next/server";
import { z } from "zod";
import { FORMAS } from "@/lib/financeiro/calculos";
import { criarContaPagar, financeiroDaFesta } from "@/lib/financeiro/servico";
import { hojeIso } from "@/lib/financeiro/http";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirRecursoPlano, recursoIncluido } from "@/lib/assinatura/recursos-plano";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const despesa = z.object({
  descricao: z.string().trim().min(1).max(160),
  categoriaId: z.string().uuid(),
  valor: z.number().positive(),
  vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  favorecido: z.string().max(160).optional(),
  forma: z.enum(FORMAS).optional(),
}).strict();

export async function GET(request: NextRequest, contexto: { params: Promise<{ festaId: string }> }) {
  try {
    const { festaId } = await contexto.params;
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), async (tx, tenant) =>
      financeiroDaFesta(tx, tenant.empresaComprovada, festaId, hojeIso(), await recursoIncluido(tx, tenant.empresaComprovada, "FINANCEIRO_COMPLETO")));
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest, contexto: { params: Promise<{ festaId: string }> }) {
  try {
    const { festaId } = await contexto.params;
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const input = despesa.parse(await request.json());
    const data = await withTenantTransaction(sessao, null, async (tx, tenant) => {
      await exigirRecursoPlano(tx, tenant.empresaComprovada, "FINANCEIRO_COMPLETO");
      return criarContaPagar(tx, tenant.empresaComprovada, tenant.usuarioId, { ...input, festaId });
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
