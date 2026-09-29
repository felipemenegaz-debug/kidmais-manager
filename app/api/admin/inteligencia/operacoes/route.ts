import type { NextRequest } from "next/server";
import { jsonNoStore } from "@/lib/http/api-response";
import { atenderOperacao } from "@/lib/inteligencia/acoes/operacoes";
import { dependenciasOperacao } from "./composicao";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Human Gate: único caminho que executa uma ação CONFIRM, sempre depois do clique humano. */
export async function POST(request: NextRequest) {
  const { status, corpo } = await atenderOperacao(
    { lerCorpo: () => request.json(), empresaSolicitada: request.nextUrl.searchParams.get("empresaId"), estabelecimentoSolicitado: request.nextUrl.searchParams.get("estabelecimentoId") },
    dependenciasOperacao(request),
  );
  return jsonNoStore(corpo, { status });
}
