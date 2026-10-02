import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { originalDoContratoImportado, podeVerOriginal } from '@/lib/contratos/importados';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { apiErrorResponse } from '@/lib/http/api-response';
import { withTenantTransaction } from '@/lib/saas/provar-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const semCache = { 'Cache-Control': 'no-store' } as const;
const TIPOS = new Set(['application/pdf', 'image/jpeg', 'image/png']);

/**
 * Original do contrato importado. Nunca tem URL pública: sessão administrativa, tenant comprovado na consulta e
 * papel NESTA empresa entre os que podem importar (ADMINISTRATIVO, REPRESENTANTE_AUTORIZADO). `?baixar=1` força download.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ importacaoId: string }> }) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const id = z.string().uuid().safeParse((await context.params).importacaoId);
    if (!id.success) return NextResponse.json({ ok: false, erro: 'Contrato inválido.' }, { status: 400, headers: semCache });
    const resultado = await withTenantTransaction(sessao, request.nextUrl.searchParams.get('empresaId'), async (tx, tenant) => {
      if (!podeVerOriginal(tenant.papelAtual)) return { tipo: 'negado' as const };
      const original = await originalDoContratoImportado(tx, tenant.empresaComprovada, id.data.toLowerCase());
      return original ? { tipo: 'ok' as const, original } : { tipo: 'ausente' as const };
    });
    if (resultado.tipo === 'negado') return NextResponse.json({ ok: false, erro: 'Seu acesso não permite ver o documento original.' }, { status: 403, headers: semCache });
    if (resultado.tipo === 'ausente') return NextResponse.json({ ok: false, erro: 'Documento não encontrado.' }, { status: 404, headers: semCache });
    const { conteudo, contentType, nome } = resultado.original;
    const tipo = TIPOS.has(contentType) ? contentType : 'application/octet-stream';
    const disposicao = request.nextUrl.searchParams.get('baixar') === '1' || tipo === 'application/octet-stream' ? 'attachment' : 'inline';
    const arquivo = nome.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'contrato-importado';
    return new NextResponse(new Uint8Array(conteudo), {
      headers: { 'Content-Type': tipo, 'Content-Disposition': `${disposicao}; filename="${arquivo}"`, 'X-Content-Type-Options': 'nosniff', ...semCache },
    });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
