import type { NextRequest } from "next/server";
import { fluxoCaixa } from "@/lib/financeiro/servico";
import { consultarFinanceiro, hojeIso } from "@/lib/financeiro/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const hoje = hojeIso();
  const inicio = request.nextUrl.searchParams.get("inicio") ?? `${hoje.slice(0, 7)}-01`;
  const fim = request.nextUrl.searchParams.get("fim") ?? hoje;
  return consultarFinanceiro(request, (tx, tenant) => fluxoCaixa(tx, tenant.empresaComprovada, inicio, fim, hoje), "FINANCEIRO_COMPLETO");
}
