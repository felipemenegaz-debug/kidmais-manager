import type { NextRequest } from "next/server";
import { consultarFinanceiro } from "@/lib/financeiro/http";
import { primeirosPassos } from "@/lib/cadastro/inicio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Início guiado da empresa comprovada (só contagens e marcadores). */
export async function GET(request: NextRequest) {
  return consultarFinanceiro(request, (tx, tenant) => primeirosPassos(tx, tenant));
}
