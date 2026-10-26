import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { exigirApresentacaoInstalada, lerFotoSalao } from "@/lib/agenda/salao-apresentacao";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Prévia administrativa da foto ativa de um salão da empresa comprovada. Nunca pública nem em cache compartilhado. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; fotoId: string }> }) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const p = await params;
    const salaoId = z.string().uuid().parse(p.id);
    const fotoId = z.string().uuid().parse(p.fotoId);
    const foto = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), async (tx, tenant) => {
      await exigirApresentacaoInstalada(tx);
      return lerFotoSalao(tx, tenant.empresaComprovada, salaoId, fotoId);
    });
    return new NextResponse(new Uint8Array(foto.conteudo), {
      headers: {
        "Content-Type": "image/webp", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ETag: `"${foto.sha256}"`,
        "Content-Security-Policy": "default-src 'none'; sandbox", "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
