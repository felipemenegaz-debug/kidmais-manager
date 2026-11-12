import { NextRequest, NextResponse } from 'next/server';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { documentoVigente, publicarPdf } from '@/lib/catalogo/documento-publico';
import { authError } from '@/lib/autenticacao/service';
import { apiErrorResponse } from '@/lib/http/api-response';
import { temAutoridadeDePlataforma } from '@/lib/autenticacao/plataforma';
import { withTenantTransaction } from '@/lib/saas/provar-tenant';
import { ehDonaDaConfigLegada } from '@/lib/disponibilidade/config-legada';

// O PDF publicado é da instalação (endereço público atual, da dona da agenda pública). Outra empresa não o vê nem o
// substitui por esta tela: para ela não há PDF publicado (o endereço /b/<código> já não o oferece).
async function daDona(request: NextRequest, sessao: Awaited<ReturnType<typeof exigirApiAdminCrmDisponivel>>) {
  return withTenantTransaction(sessao, request.nextUrl.searchParams.get('empresaId'), (tx, tenant) => ehDonaDaConfigLegada(tx, tenant.empresaComprovada));
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    if (!(await daDona(request, sessao))) return NextResponse.json({ ok: true, data: null, daInstalacao: false }, { headers });
    const documento = await documentoVigente();
    return NextResponse.json({ ok: true, daInstalacao: true, data: documento && { id: documento.id, nome: documento.nome_arquivo, tamanho: documento.tamanho_bytes, publicadoEm: documento.publicado_em } }, { headers });
  } catch (error) { return apiErrorResponse(error); }
}
export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    // Documento único da instalação (sem empresa): autoridade de PLATAFORMA, nunca papel de empresa (F1).
    if (!temAutoridadeDePlataforma(sessao)) throw authError('Somente o proprietário autorizado pode publicar a tabela.', 403);
    if (!(await daDona(request, sessao))) throw authError('O envio do PDF de pacotes desta empresa ainda não está disponível.', 403);
    const form = await request.formData();
    const file = form.get('arquivo');
    if (!(file instanceof File) || file.type !== 'application/pdf' || file.size > 10 * 1024 * 1024)
      return NextResponse.json({ ok: false, erro: 'Envie um PDF de até 10 MB.' }, { status: 400, headers });
    const data = await publicarPdf(Buffer.from(await file.arrayBuffer()), file.name);
    return NextResponse.json({ ok: true, data: { id: data.id, nome: data.nome_arquivo, publicadoEm: data.publicado_em } }, { headers });
  } catch (error) { return apiErrorResponse(error); }
}
