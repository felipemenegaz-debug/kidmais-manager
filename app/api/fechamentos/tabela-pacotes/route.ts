import { NextResponse } from 'next/server';
import { documentoVigente, lerPdfVigente } from '@/lib/catalogo/documento-publico';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function HEAD() {
  try { return new Response(null, { status: await documentoVigente() ? 204 : 404, headers: { 'Cache-Control': 'no-store' } }); }
  catch { return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
}

export async function GET() {
  try {
    const atual = await lerPdfVigente();
    if (!atual) return NextResponse.json({ erro: 'Tabela ainda não publicada.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return new NextResponse(new Uint8Array(atual.bytes), { headers: {
      'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="pacotes-e-precos.pdf"',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    } });
  } catch { return NextResponse.json({ erro: 'Tabela indisponível no momento.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
}
