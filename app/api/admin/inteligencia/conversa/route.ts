import type { NextRequest } from "next/server";
import { jsonNoStore } from "@/lib/http/api-response";
import { atenderConversa } from "@/lib/inteligencia/conversa";
import { dependenciasConversa } from "../dependencias";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Drawer "Perguntar ao Kidmais": texto livre → leitura, rascunho sob Human Gate ou resposta honesta. Nunca executa escrita. */
export async function POST(request: NextRequest) {
  const { status, corpo } = await atenderConversa(
    { lerCorpo: () => request.json(), empresaSolicitada: request.nextUrl.searchParams.get("empresaId"), estabelecimentoSolicitado: request.nextUrl.searchParams.get("estabelecimentoId") },
    dependenciasConversa(request),
  );
  return jsonNoStore(corpo, { status });
}
