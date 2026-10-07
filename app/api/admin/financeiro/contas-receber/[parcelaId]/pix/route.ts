import type { NextRequest } from "next/server";
import { consultarFinanceiro, hojeIso } from "@/lib/financeiro/http";
import { pixDaParcela } from "@/lib/pagamentos/pix/recebimento";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pix copia e cola + QR estático da parcela, com a chave da própria empresa. Somente leitura; a baixa segue manual. */
export async function GET(request: NextRequest, context: { params: Promise<{ parcelaId: string }> }) {
  const { parcelaId } = await context.params;
  return consultarFinanceiro(request, (tx, tenant) => pixDaParcela(tx, tenant, parcelaId, hojeIso()));
}
