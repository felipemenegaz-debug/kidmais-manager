import { transporteMcp } from "./dependencias";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Canal MCP externo (Streamable HTTP, stateless). Só POST; GET/DELETE respondem 405 pelo próprio transporte.
 * MCP_ENABLED desligado ⇒ 503 antes de autenticar ou abrir banco. Identidade: Bearer da concessão OAuth (105).
 */
async function atender(request: Request) {
  return transporteMcp()(request);
}

export const POST = atender;
export const GET = atender;
export const DELETE = atender;
export const PUT = atender;
export const PATCH = atender;
export const OPTIONS = atender;
