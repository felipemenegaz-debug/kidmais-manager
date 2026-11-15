import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel, tokenAdmin } from '@/lib/http/admin-crm-api';
import { apiErrorResponse } from '@/lib/http/api-response';
import { lerAssinaturaPapelAdmin, TIPOS_ARQUIVO } from '@/lib/contratos/services/assinatura-papel-cliente.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const semCache = { 'Cache-Control': 'no-store' } as const;
const EXTENSAO: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

/**
 * 124 — Cópia digitalizada do contrato assinado em papel. Nunca tem URL pública: sessão administrativa, tenant comprovado
 * na consulta e Gestão NESTA empresa. Sempre download (attachment), sem cache e com nosniff. Sem cópia ou outra empresa = 404.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ versaoId: string }> }) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const id = z.string().uuid().safeParse((await context.params).versaoId);
    if (!id.success) return NextResponse.json({ ok: false, erro: 'Contrato inválido.' }, { status: 400, headers: semCache });
    const r = await lerAssinaturaPapelAdmin(id.data.toLowerCase(), tokenAdmin(request), request.nextUrl.searchParams.get('empresaId'), true);
    if (!r.temArquivo || !r.arquivo || !r.tipo || !(TIPOS_ARQUIVO as readonly string[]).includes(r.tipo))
      return NextResponse.json({ ok: false, erro: 'Nenhuma cópia anexada.' }, { status: 404, headers: semCache });
    return new NextResponse(new Uint8Array(r.arquivo), {
      headers: {
        'Content-Type': r.tipo,
        'Content-Disposition': `attachment; filename="contrato-assinado-papel.${EXTENSAO[r.tipo]}"`,
        'X-Content-Type-Options': 'nosniff',
        ...(r.sha256 ? { 'X-Conteudo-Sha256': r.sha256 } : {}),
        ...semCache,
      },
    });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
