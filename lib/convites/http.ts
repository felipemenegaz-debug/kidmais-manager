import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { ConviteError, exigir } from './domain';
export const headersConvite = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow, noarchive' };
export async function responder(fn: () => Promise<unknown>) {
  try { return NextResponse.json({ ok: true, data: await fn() }, { headers: headersConvite }); }
  catch (e) {
    const known = e as { httpStatus?: number; status?: number; message?: string };
    const status = e instanceof ZodError || e instanceof SyntaxError ? 400 : e instanceof ConviteError ? e.status : known.httpStatus ?? 500;
    return NextResponse.json({ ok: false, erro: status === 400 ? 'Confira os campos do convite.' : status < 500 || e instanceof ConviteError ? known.message : 'Não foi possível concluir. Tente novamente mais tarde.' }, { status, headers: headersConvite });
  }
}
export function origemPublica(r: NextRequest) {
  const configurada = process.env.CONVITES_PUBLIC_ORIGIN || process.env.ADMIN_AUTH_ORIGIN;
  exigir(configurada, 'Origem dos convites não configurada.', 503);
  exigir(r.headers.get('origin') === new URL(configurada).origin, 'Origem recusada.', 403);
}
export function tokenFamilia(r: Request): string | null {
  const cabecalho = r.headers.get('authorization');
  if (cabecalho == null) return null;
  const token = /^Bearer ([\w-]{43})$/.exec(cabecalho)?.[1];
  exigir(token, 'Link da família indisponível. Solicite um novo ao organizador.', 404);
  return token;
}
export async function corpo(r: Request) {
  exigir(r.headers.get('content-type')?.startsWith('application/json'), 'Use JSON.', 415);
  const reader = r.body?.getReader(); exigir(reader, 'Requisição vazia.', 400);
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.byteLength;
    if (total > 7_100_000) { await reader.cancel(); throw new ConviteError('Arquivo muito grande.', 413); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
