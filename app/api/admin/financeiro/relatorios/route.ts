import type { NextRequest } from "next/server";
import { relatorio } from "@/lib/financeiro/servico";
import { consultarFinanceiro, hojeIso, periodoDaUrl } from "@/lib/financeiro/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const hoje = hojeIso();
  const periodo = periodoDaUrl(request, hoje);
  return consultarFinanceiro(request, (tx, tenant) => relatorio(tx, tenant.empresaComprovada, periodo.inicio, periodo.fim, hoje), "FINANCEIRO_COMPLETO");
}
