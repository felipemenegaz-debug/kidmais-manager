import { NextRequest, NextResponse } from 'next/server';
import { artePublica, confirmar, consultarPublico, limitarHttp, publico } from '@/lib/convites/service';
import { corpo, headersConvite, origemPublica, responder, tokenFamilia } from '@/lib/convites/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Contexto = { params: Promise<{ token: string }> };
export async function GET(r: NextRequest, ctx: Contexto) {
  const { token } = await ctx.params;
  if (r.nextUrl.searchParams.get('arte') === '1') {
    try { const b = await artePublica(token); return new NextResponse(new Uint8Array(b), { headers: { ...headersConvite, 'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff' } }); }
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
