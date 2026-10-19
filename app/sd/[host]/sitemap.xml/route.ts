import type { NextRequest } from "next/server";
import { respostaSitemap, viaDominioConfirmada } from "@/lib/marketing/site/rotas-publicas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ host: string }> }) {
  const via = viaDominioConfirmada((await params).host, request.headers);
  if (!via) return new Response("Não encontrado.", { status: 404 });
  return respostaSitemap(via);
}
