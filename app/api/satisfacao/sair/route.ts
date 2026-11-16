import type { NextRequest } from "next/server";
import { rotaPublica } from "@/lib/satisfacao/http";
import { sairDasPesquisas } from "@/lib/satisfacao/publico";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Saída das pesquisas desta empresa (só POST; GET não grava). Token só no corpo (vem do fragmento do link). */
export async function POST(request: NextRequest) {
  return rotaPublica(request, (corpo, ctx) => sairDasPesquisas(corpo, ctx));
}
