import type { NextRequest } from "next/server";
import { respostaFotoSalao } from "@/lib/agenda/salao-publico-rotas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** S-D: foto pública de um salão pronto (revalidada a cada exibição). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ salaoId: string; fotoId: string }> }) {
  const { salaoId, fotoId } = await params;
  return respostaFotoSalao(request, salaoId, fotoId);
}
