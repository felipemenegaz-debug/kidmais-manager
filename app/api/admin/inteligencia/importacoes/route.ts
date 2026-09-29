import type { NextRequest } from "next/server";
import { jsonNoStore } from "@/lib/http/api-response";
import { atenderImportacao } from "@/lib/inteligencia/importacao/revisao";
import { dependenciasImportacao } from "./composicao";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Abertura e revisão da importação e preparação do Human Gate. A gravação só acontece em /operacoes, depois do clique. */
export async function POST(request: NextRequest) {
  const { status, corpo } = await atenderImportacao(
    { lerCorpo: () => request.json(), empresaSolicitada: request.nextUrl.searchParams.get("empresaId") },
    dependenciasImportacao(request),
  );
  return jsonNoStore(corpo, { status });
}
