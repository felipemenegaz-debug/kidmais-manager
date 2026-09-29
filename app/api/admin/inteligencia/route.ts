import type { NextRequest } from "next/server";
import { jsonNoStore } from "@/lib/http/api-response";
import { atenderInteligencia } from "@/lib/inteligencia/gateway";
import { dependenciasGateway } from "./dependencias";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST para exigir origem e CSRF do guard administrativo, embora as capacidades aqui sejam somente leitura. */
export async function POST(request: NextRequest) {
  const { status, corpo } = await atenderInteligencia(
    {
      lerCorpo: () => request.json(),
      empresaSolicitada: request.nextUrl.searchParams.get("empresaId"),
    },
    dependenciasGateway(request),
  );
  return jsonNoStore(corpo, { status });
}
