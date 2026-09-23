import { NextRequest, NextResponse } from 'next/server';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { documentoVigente, publicarPdf } from '@/lib/catalogo/documento-publico';
import { authError } from '@/lib/autenticacao/service';
import { apiErrorResponse } from '@/lib/http/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const documento = await documentoVigente();
    return NextResponse.json({ ok: true, data: documento && { id: documento.id, nome: documento.nome_arquivo, tamanho: documento.tamanho_bytes, publicadoEm: documento.publicado_em } }, { headers });
  } catch (error) { return apiErrorResponse(error); }
}
export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    if (sessao.papel !== 'REPRESENTANTE_AUTORIZADO') throw authError('Somente o proprietário autorizado pode publicar a tabela.', 403);
    const form = await request.formData();
    const file = form.get('arquivo');
    if (!(file instanceof File) || file.type !== 'application/pdf' || file.size > 10 * 1024 * 1024)
      return NextResponse.json({ ok: false, erro: 'Envie um PDF de até 10 MB.' }, { status: 400, headers });
    const data = await publicarPdf(Buffer.from(await file.arrayBuffer()), file.name);
    return NextResponse.json({ ok: true, data: { id: data.id, nome: data.nome_arquivo, publicadoEm: data.publicado_em } }, { headers });
  } catch (error) { return apiErrorResponse(error); }
}
