import type { NextRequest } from "next/server";
import { relatorio } from "@/lib/financeiro/servico";
import { consultarFinanceiro, hojeIso } from "@/lib/financeiro/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return consultarFinanceiro(request, (tx, tenant) => relatorio(tx, tenant.empresaComprovada, hojeIso()));
}
