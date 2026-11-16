import type { NextRequest } from "next/server";
import { rotaPublica } from "@/lib/satisfacao/http";
import { abrirPesquisa } from "@/lib/satisfacao/publico";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Abre a pesquisa: primeiro nome, buffet, unidade e data (ou já respondida). Token só no corpo (vem do fragmento do link). */
export async function POST(request: NextRequest) {
  return rotaPublica(request, (corpo, ctx) => abrirPesquisa(corpo, ctx));
}
