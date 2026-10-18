import type { NextRequest } from "next/server";
import { respostaWhatsapp } from "@/lib/marketing/site/rotas-publicas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  return respostaWhatsapp({ tipo: "PLATAFORMA", slug: (await params).slug }, request);
}
