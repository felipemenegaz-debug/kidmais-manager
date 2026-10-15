import { NextResponse, type NextRequest } from "next/server";
import { db, withTransaction } from "@/lib/db/postgres";
import { secretMatches } from "@/lib/integracoes/gupshup/webhook";
import { executarCiclo } from "@/lib/marketing/automacoes/motor";
import { automacoesHabilitadas, transporteDoAmbiente } from "@/lib/marketing/automacoes/transporte";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const responder = (corpo: unknown, status = 200) => NextResponse.json(corpo, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });

/**
 * Ciclo das automações para o processador local (scripts/marketing-automacoes-worker.mjs). Exige segredo próprio
 * (MARKETING_AUTOMACOES_WORKER_SECRET, comparação em tempo constante) e o interruptor MARKETING_AUTOMACOES_ENABLED=true.
 * Transporte: só o simulado. Log com código fixo, sem dado pessoal.
 */
export async function POST(request: NextRequest) {
  const segredo = process.env.MARKETING_AUTOMACOES_WORKER_SECRET;
  if (!segredo || segredo.length < 32 || !secretMatches(request.headers.get("x-kidmais-worker-secret") ?? "", segredo)) {
    return responder({ ok: false, codigo: "NAO_AUTORIZADO" }, 401);
  }
  if (!automacoesHabilitadas()) return responder({ ok: false, codigo: "AUTOMACOES_DESLIGADAS" }, 409);
  try {
    const resultado = await executarCiclo({ transacao: withTransaction }, transporteDoAmbiente(db), new Date(), { limite: 100 });
    return responder({ ok: true, data: resultado });
  } catch (error) {
    console.error("[marketing-automacoes] ciclo falhou", error instanceof Error ? error.name : typeof error);
    return responder({ ok: false, codigo: "CICLO_FALHOU" }, 500);
  }
}
