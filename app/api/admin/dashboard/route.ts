import type { NextRequest } from "next/server";
import { painelGeral } from "@/lib/financeiro/servico";
import { consultarFinanceiro, hojeIso } from "@/lib/financeiro/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const hoje = hojeIso();
  return consultarFinanceiro(request, (tx, tenant) => painelGeral(tx, tenant.empresaComprovada, hoje));
}
