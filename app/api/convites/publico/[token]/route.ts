import { NextRequest, NextResponse } from 'next/server';
import { artePublica, confirmar, consultarPublico, limitarHttp, logoPublica, publico } from '@/lib/convites/service';
import { ConviteError } from '@/lib/convites/domain';
import { corpo, headersConvite, origemPublica, responder, tokenFamilia } from '@/lib/convites/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Contexto = { params: Promise<{ token: string }> };
export async function GET(r: NextRequest, ctx: Contexto) {
  const { token } = await ctx.params;
  // ?arte=1: arte publicada atual (compatível). Etapa 3: ?arte=<uuid> só serve se ainda for a arte publicada (409 sem bytes).
  const arte = r.nextUrl.searchParams.get('arte');
  if (arte !== null) {
    const esperada = arte === '1' ? null : arte;
    if (esperada !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(esperada)) return new NextResponse(null, { status: 404, headers: headersConvite });
    try { const b = await artePublica(token, esperada); return new NextResponse(new Uint8Array(b), { headers: { ...headersConvite, 'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff' } }); }
    catch (e) { return new NextResponse(null, { status: e instanceof ConviteError && e.status === 409 ? 409 : 404, headers: headersConvite }); }
  }
  // Logo do buffet no rodapé (fora da arte): só quando o convite publicado pede e o buffet tem logo aplicada.
  if (r.nextUrl.searchParams.get('logo') === '1') {
    try { const l = await logoPublica(token); return new NextResponse(new Uint8Array(l.bytes), { headers: { ...headersConvite, 'Content-Type': l.tipo, 'X-Content-Type-Options': 'nosniff' } }); }
    catch { return new NextResponse(null, { status: 404, headers: headersConvite }); }
  }
  return responder(async () => consultarPublico(token, tokenFamilia(r)));
}
export async function POST(r: NextRequest, ctx: Contexto) { return responder(async () => {
  origemPublica(r); const { token } = await ctx.params;
  const { c } = await publico(token);
  // Limite agregado independente de cabeçalhos de IP controláveis pelo visitante.
  await limitarHttp(`rsvp:${c.id}`, 300);
  return confirmar(token, await corpo(r), tokenFamilia(r));
}); }
