import type { NextRequest } from "next/server";
import { z } from "zod";
import { confirmarAbertura, leituraAbertura } from "@/lib/financeiro/escritor-p2";
import { consultarFinanceiro } from "@/lib/financeiro/http";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { exigirGestaoNoTenant, withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirRecursoPlano } from "@/lib/assinatura/recursos-plano";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: vigente, pendências e prévia para `?dataBase=` (padrão hoje). POST: confirmar ou corrigir, só a Gestão. */
export async function GET(request: NextRequest) {
  // podeGerir só orienta a tela; quem barra é exigirGestaoNoTenant no POST.
  return consultarFinanceiro(request, async (tx, tenant) => ({
    ...(await leituraAbertura(tx, tenant.empresaComprovada, request.nextUrl.searchParams.get("dataBase"))),
    podeGerir: tenant.papelAtual === "REPRESENTANTE_AUTORIZADO",
  }), "FINANCEIRO_COMPLETO");
}

const corpo = z.object({
  dataBase: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  saldo: z.number().finite().min(-999_999_999_999.99).max(999_999_999_999.99),
  justificativa: z.string().trim().min(3).max(1000),
  versaoEsperada: z.number().int().min(0),
  conjuntoHash: z.string().regex(/^[0-9a-f]{64}$/),
  chave: z.string().min(8).max(160),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const input = corpo.parse(await request.json());
    const data = await withTenantTransaction(sessao, null, async (tx, tenant) => {
      exigirGestaoNoTenant(tenant, "Só a gestão da empresa confirma a abertura de saldo.");
      await exigirRecursoPlano(tx, tenant.empresaComprovada, "FINANCEIRO_COMPLETO");
      return confirmarAbertura(tx, tenant.empresaComprovada, tenant.usuarioId, input);
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
