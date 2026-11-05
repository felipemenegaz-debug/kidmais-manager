import { metadadosRecurso } from "@/lib/integracoes/oauth/servico";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 9728: metadados do recurso protegido (raiz e sufixo /api/mcp). Canal desligado ⇒ 404. */
export async function GET() {
  try {
    return Response.json(metadadosRecurso(process.env), { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  }
}
