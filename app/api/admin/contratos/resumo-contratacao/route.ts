import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { detalheAdministrativo } from "@/lib/contratos/services/administrativo.service";
import { ResumoTenantError, resumoContratacaoDoTenant } from "@/lib/contratos/services/resumo-tenant";
import { apiErrorResponse } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { consultarPainelFinanceiro } from "@/lib/pagamentos/services/financeiro-consulta.service";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NAO_ENCONTRADO = { ok: false, erro: "Contrato não encontrado.", codigo: "NAO_ENCONTRADO" } as const;

/**
 * Dados do Resumo da Contratação (tela e PDF). Prova o tenant e lê na MESMA transação (D1):
 * sessão → Tenant Context → contrato da empresa comprovada → painel e financeiro no mesmo `tx` → commit.
 */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const contratoId = z.string().uuid().safeParse(request.nextUrl.searchParams.get("contratoId") ?? "");
    // Id malformado responde como inexistente: nada distingue "não existe" de "é de outra empresa".
    if (!contratoId.success) return NextResponse.json(NAO_ENCONTRADO, { status: 404, headers: { "Cache-Control": "no-store" } });
    const data = await resumoContratacaoDoTenant(sessao, request.nextUrl.searchParams.get("empresaId"), contratoId.data, {
      withTenantTransaction,
      painel: detalheAdministrativo,
      financeiro: consultarPainelFinanceiro,
    });
    return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ResumoTenantError) return NextResponse.json(NAO_ENCONTRADO, { status: 404, headers: { "Cache-Control": "no-store" } });
    return apiErrorResponse(error);
  }
}
