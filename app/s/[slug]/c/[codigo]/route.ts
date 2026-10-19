import type { NextRequest } from "next/server";
import { respostaCliqueCampanha } from "@/lib/marketing/site/rotas-publicas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string; codigo: string }> }) {
  const { slug, codigo } = await params;
  return respostaCliqueCampanha({ tipo: "PLATAFORMA", slug }, codigo, request);
}
