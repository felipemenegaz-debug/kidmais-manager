import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse } from "@/lib/http/api-response";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirRecursoPlano } from "@/lib/assinatura/recursos-plano";
import { exigirCapacidadeMarketing } from "@/lib/marketing/capacidades";
import { MarketingError } from "@/lib/marketing/erros";
import { lerCorpo, parametroUuid, rotaMarketing } from "@/lib/marketing/http";
import { imagemDaEmpresa, listarImagens, removerImagem } from "@/lib/marketing/site/imagens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Prévia administrativa: imagem do site da empresa comprovada (inclusive ainda não publicada). Nunca pública. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ imagemId: string }> }) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const imagemId = parametroUuid((await params).imagemId);
    if (!imagemId) throw new MarketingError("MARKETING_NAO_ENCONTRADO", "Imagem não encontrada.", 404);
    const imagem = await withTenantTransaction(sessao, null, async (tx, tenant) => {
      await exigirRecursoPlano(tx, tenant.empresaComprovada, "MARKETING");
      await exigirCapacidadeMarketing(tx, tenant, "MARKETING_VISUALIZAR");
      return imagemDaEmpresa(tx, tenant.empresaComprovada, imagemId);
    });
    if (!imagem) throw new MarketingError("MARKETING_NAO_ENCONTRADO", "Imagem não encontrada.", 404);
    return new NextResponse(new Uint8Array(imagem.conteudo), {
      headers: {
        "Content-Type": "image/webp", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox", "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

const esquema = z.object({ acao: z.literal("remover"), siteId: z.string().uuid() }).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ imagemId: string }> }) {
  return rotaMarketing(request, exigirApiAdminCrmDisponivel, { capacidade: "MARKETING_SITE_EDITAR" }, async ({ tx, tenant }) => {
    const imagemId = parametroUuid((await params).imagemId);
    if (!imagemId) throw new MarketingError("MARKETING_NAO_ENCONTRADO", "Imagem não encontrada.", 404);
    const { siteId } = esquema.parse(await lerCorpo(request));
    await removerImagem(tx, tenant.empresaComprovada, siteId, imagemId);
    return { imagens: await listarImagens(tx, tenant.empresaComprovada, siteId) };
  });
}
