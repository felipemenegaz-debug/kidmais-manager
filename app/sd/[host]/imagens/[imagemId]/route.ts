import type { NextRequest } from "next/server";
import { respostaImagem, viaDominioConfirmada } from "@/lib/marketing/site/rotas-publicas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ host: string; imagemId: string }> }) {
  const { host, imagemId } = await params;
  const via = viaDominioConfirmada(host, request.headers);
  if (!via) return new Response("Não encontrado.", { status: 404 });
  return respostaImagem(via, imagemId);
}
