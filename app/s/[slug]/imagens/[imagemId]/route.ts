import { respostaImagem } from "@/lib/marketing/site/rotas-publicas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string; imagemId: string }> }) {
  const { slug, imagemId } = await params;
  return respostaImagem({ tipo: "PLATAFORMA", slug }, imagemId);
}
