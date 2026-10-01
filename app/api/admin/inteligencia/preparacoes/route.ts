import type { NextRequest } from "next/server";
import { jsonNoStore } from "@/lib/http/api-response";
import { atenderPreparacao } from "@/lib/inteligencia/acoes/preparacoes";
import { dependenciasPreparacao } from "../operacoes/composicao";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Revisão oficial de uma contratação preparada pelo Kidmais: abrir (somente leitura) ou concluir o formulário oficial
 * consumindo a preparação. `?empresaId=` só escolhe entre memberships do próprio usuário; o Core prova o tenant.
 */
export async function POST(request: NextRequest) {
  const { status, corpo } = await atenderPreparacao(() => request.json(), dependenciasPreparacao(request, request.nextUrl.searchParams.get("empresaId")));
  return jsonNoStore(corpo, { status });
}
