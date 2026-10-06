import type { NextRequest } from "next/server";
import { consultarFinanceiro } from "@/lib/financeiro/http";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { contextoDaRequisicao } from "@/lib/acessos/http";
import { alterarConfiguracaoPix, consultarConfiguracaoPix } from "@/lib/pagamentos/pix/recebimento";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Chave Pix de recebimento DA EMPRESA comprovada (066). Leitura para qualquer vínculo ativo; alteração só Gestão. */
export async function GET(request: NextRequest) {
  return consultarFinanceiro(request, (tx, tenant) => consultarConfiguracaoPix(tx, tenant));
}

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const json: unknown = await request.json();
    const ctx = contextoDaRequisicao(request);
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), (tx, tenant) =>
      alterarConfiguracaoPix(tx, tenant, sessao, json, ctx));
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
