import { NextResponse } from 'next/server';
import { documentoVigente, lerPdfVigente } from '@/lib/catalogo/documento-publico';
// O PDF publicado é da instalação (endereço atual). Pelo endereço de outra empresa ele não existe.
const deOutraEmpresa = (url: string) => new URL(url).searchParams.has('empresa');
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function HEAD(request: Request) {
  if (deOutraEmpresa(request.url)) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  try { return new Response(null, { status: await documentoVigente() ? 204 : 404, headers: { 'Cache-Control': 'no-store' } }); }
  catch { return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
}

export async function GET(request: Request) {
  try {
    if (deOutraEmpresa(request.url)) return NextResponse.json({ erro: 'Tabela ainda não publicada.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const atual = await lerPdfVigente();
    if (!atual) return NextResponse.json({ erro: 'Tabela ainda não publicada.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const disposicao = new URL(request.url).searchParams.get('download') === '1' ? 'attachment' : 'inline';
    return new NextResponse(new Uint8Array(atual.bytes), { headers: {
      'Content-Type': 'application/pdf', 'Content-Disposition': `${disposicao}; filename="pacotes-e-precos.pdf"`,
      'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    } });
  } catch { return NextResponse.json({ erro: 'Tabela indisponível no momento.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
}
