import type { NextRequest } from "next/server";
import { painelGeral } from "@/lib/financeiro/servico";
import { consultarFinanceiro, hojeIso } from "@/lib/financeiro/http";
import { recursoIncluido } from "@/lib/assinatura/recursos-plano";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const hoje = hojeIso();
  return consultarFinanceiro(request, async (tx, tenant) =>
    painelGeral(tx, tenant.empresaComprovada, hoje, await recursoIncluido(tx, tenant.empresaComprovada, "FINANCEIRO_COMPLETO")));
}
