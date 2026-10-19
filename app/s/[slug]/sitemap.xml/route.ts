import { respostaSitemap } from "@/lib/marketing/site/rotas-publicas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  return respostaSitemap({ tipo: "PLATAFORMA", slug: (await params).slug });
}
