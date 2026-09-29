import type { NextRequest } from "next/server";
import { jsonNoStore } from "@/lib/http/api-response";
import { atenderCustos } from "@/lib/inteligencia/custos";
import { dependenciasCustos } from "../dependencias";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Visão consolidada de custos de IA da empresa comprovada (Gestão). POST pelo guard de origem/CSRF; somente leitura. */
export async function POST(request: NextRequest) {
  const { status, corpo } = await atenderCustos(
    { lerCorpo: () => request.json(), empresaSolicitada: request.nextUrl.searchParams.get("empresaId") },
    dependenciasCustos(request),
  );
  return jsonNoStore(corpo, { status });
}
