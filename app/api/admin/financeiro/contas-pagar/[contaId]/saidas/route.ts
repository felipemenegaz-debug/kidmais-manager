import type { NextRequest } from "next/server";
import { z } from "zod";
import { pagamentosDaConta } from "@/lib/financeiro/escritor-p2";
import { consultarFinanceiro } from "@/lib/financeiro/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pagamentos lançados de uma conta, com o que já foi revertido de cada um. Só leitura; base do diálogo de reversão. */
export async function GET(request: NextRequest, context: { params: Promise<{ contaId: string }> }) {
  const { contaId } = await context.params;
  return consultarFinanceiro(request, async (tx, tenant) => ({
    pagamentos: await pagamentosDaConta(tx, tenant.empresaComprovada, z.string().uuid().parse(contaId)),
  }), "FINANCEIRO_COMPLETO");
}
