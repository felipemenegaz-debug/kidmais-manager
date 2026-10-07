import type { NextRequest } from "next/server";
import { consultarFinanceiro } from "@/lib/financeiro/http";
import { consultarAssinatura } from "@/lib/assinatura/consulta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Situação comercial da empresa comprovada. Sempre permitida pelo paywall (conta e cobrança), inclusive bloqueada. */
export async function GET(request: NextRequest) {
  return consultarFinanceiro(request, (tx, tenant) => consultarAssinatura(tx, tenant));
}
