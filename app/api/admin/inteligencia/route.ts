import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { jsonNoStore } from "@/lib/http/api-response";
import { atenderInteligencia } from "@/lib/inteligencia/gateway";
import { registrarRastreio } from "@/lib/inteligencia/rastreio";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST para exigir origem e CSRF do guard administrativo, embora a V1 seja somente leitura. */
export async function POST(request: NextRequest) {
  const { status, corpo } = await atenderInteligencia(
    {
      lerCorpo: () => request.json(),
      empresaSolicitada: request.nextUrl.searchParams.get("empresaId"),
    },
    {
      env: process.env,
      autenticar: () => exigirApiAdminCrmDisponivel(request),
      withTenantTransaction,
      agora: () => new Date(),
      requestId: randomUUID,
      registrar: (rastreio) => registrarRastreio(rastreio),
    },
  );
  return jsonNoStore(corpo, { status });
}
