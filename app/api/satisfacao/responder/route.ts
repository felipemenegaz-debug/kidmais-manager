import type { NextRequest } from "next/server";
import { rotaPublica } from "@/lib/satisfacao/http";
import { responderPesquisa } from "@/lib/satisfacao/publico";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Grava a resposta (uma por pesquisa; a primeira vale). Token só no corpo (vem do fragmento do link). */
export async function POST(request: NextRequest) {
  return rotaPublica(request, (corpo, ctx) => responderPesquisa(corpo, ctx));
}
