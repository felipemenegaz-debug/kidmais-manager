import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { exigirApiAdminCrmDisponivel, tokenAdmin } from '@/lib/http/admin-crm-api';
import { apiErrorResponse } from '@/lib/http/api-response';
import {
  lerAssinaturaPapelAdmin, registrarAssinaturaPapelCliente, registroPapelSchema, TAMANHO_MAXIMO_ARQUIVO, type ArquivoPapel,
} from '@/lib/contratos/services/assinatura-papel-cliente.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const semCache = { 'Cache-Control': 'no-store' } as const;
type Params = { params: Promise<{ versaoId: string }> };

const invalido = (detalhes?: unknown) =>
  NextResponse.json({ ok: false, erro: 'Dados inválidos ou campos não permitidos para esta ação.', ...(detalhes ? { detalhes } : {}) }, { status: 400, headers: semCache });

/**
 * 124 — Registra que o CLIENTE assinou o contrato em papel. Somente a Gestão da empresa comprovada (conferido no serviço
 * e de novo no banco). multipart/form-data: dataDeclarada, observacao?, chaveIdempotencia e arquivo? (PDF/JPEG/PNG até 25 MB).
 * Tamanho e sha256 são calculados no servidor; nada além dos bytes e do tipo vem do navegador.
 */
export async function POST(request: NextRequest, context: Params) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const id = z.string().uuid().safeParse((await context.params).versaoId);
    if (!id.success) return invalido();
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) return invalido();
    const form = await request.formData();
    const permitidos = new Set(['dataDeclarada', 'observacao', 'chaveIdempotencia', 'arquivo']);
    for (const chave of form.keys()) if (!permitidos.has(chave)) return invalido();
    const texto = (k: string) => { const v = form.get(k); return typeof v === 'string' ? v : v == null ? undefined : null; };
    const campos = { dataDeclarada: texto('dataDeclarada'), observacao: texto('observacao'), chaveIdempotencia: texto('chaveIdempotencia') };
    if (Object.values(campos).some((v) => v === null)) return invalido();
    const parsed = registroPapelSchema.safeParse(Object.fromEntries(Object.entries(campos).filter(([, v]) => v !== undefined)));
    if (!parsed.success) return invalido(parsed.error.flatten());
    const bruto = form.get('arquivo');
    let arquivo: ArquivoPapel | null = null;
    if (bruto !== null && !(typeof bruto === 'string' && bruto === '')) {
      if (!(bruto instanceof File)) return invalido();
      if (bruto.size > TAMANHO_MAXIMO_ARQUIVO)
        return NextResponse.json({ ok: false, erro: 'O arquivo precisa ter até 25 MB.' }, { status: 422, headers: semCache });
      arquivo = { bytes: Buffer.from(await bruto.arrayBuffer()), tipo: bruto.type };
    }
    const data = await registrarAssinaturaPapelCliente(id.data.toLowerCase(), parsed.data, arquivo, tokenAdmin(request),
      { requestId: randomUUID(), ip: null, userAgent: request.headers.get('user-agent')?.slice(0, 1000) ?? null },
      request.nextUrl.searchParams.get('empresaId'));
    return NextResponse.json({ ok: true, data }, { headers: semCache });
  } catch (e) {
    return apiErrorResponse(e);
  }
}

/** Metadados do registro (sem os bytes), só para a Gestão desta empresa. Outra empresa = 404. */
export async function GET(request: NextRequest, context: Params) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const id = z.string().uuid().safeParse((await context.params).versaoId);
    if (!id.success) return invalido();
    const data = await lerAssinaturaPapelAdmin(id.data.toLowerCase(), tokenAdmin(request), request.nextUrl.searchParams.get('empresaId'), false);
    return NextResponse.json({ ok: true, data }, { headers: semCache });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
