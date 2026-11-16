import type { NextRequest } from "next/server";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { rotaSatisfacaoAdmin } from "@/lib/satisfacao/admin-http";
import { lerResultados } from "@/lib/satisfacao/resultados";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Resultados da pesquisa no escopo VER do tenant (PS-4). Só leitura; período pela data da festa (D-PS4-1). */
export async function GET(request: NextRequest) {
  return rotaSatisfacaoAdmin(request, exigirApiAdminCrmDisponivel, async ({ tx, tenant }) => {
    const q = request.nextUrl.searchParams;
    return lerResultados(tx, tenant, {
      inicio: q.get("inicio"), fim: q.get("fim"), atalho: q.get("atalho"), unidade: q.get("unidade"),
      grupo: q.get("grupo"), comComentario: q.get("comComentario"), cursor: q.get("cursor"),
    });
  });
}
