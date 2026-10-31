import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { ambienteFesta } from '@/lib/festas/service';
import { miniaturaConvite } from '@/lib/convites/biblioteca';
import { headersConvite, responder } from '@/lib/convites/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(r: NextRequest) {
  try {
    await ambienteFesta();
    const sessao = await exigirApiAdminCrmDisponivel(r);
    const original = await miniaturaConvite(sessao, r.nextUrl.searchParams.get('conviteId') ?? '');
    const imagem = await sharp(original).resize(320, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
    return new NextResponse(new Uint8Array(imagem), { headers: { ...headersConvite, 'Content-Type': 'image/webp' } });
  } catch (e) { return responder(async () => { throw e; }); }
}
