import { metadadosServidor } from "@/lib/integracoes/oauth/servico";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 8414: metadados do servidor de autorização (CIMD + PKCE S256 + cliente público). Canal desligado ⇒ 404. */
export async function GET() {
  try {
    return Response.json(metadadosServidor(process.env), { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  }
}
