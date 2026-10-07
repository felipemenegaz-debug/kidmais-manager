import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { contextoDaRequisicao } from "@/lib/acessos/http";
import { hojeIso } from "@/lib/financeiro/http";
import { exportarDados, TIPOS_EXPORTACAO } from "@/lib/assinatura/exportacao";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** CSV dos dados da própria empresa (só Gestão, auditado). Sempre permitido pelo paywall: o vencimento não prende os dados. */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const tipo = z.enum(TIPOS_EXPORTACAO).parse(request.nextUrl.searchParams.get("tipo"));
    const ctx = contextoDaRequisicao(request);
    const r = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), (tx, tenant) => exportarDados(tx, tenant, tipo, ctx, hojeIso()));
    return new NextResponse(r.conteudo, {
      status: 200,
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${r.arquivo}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
