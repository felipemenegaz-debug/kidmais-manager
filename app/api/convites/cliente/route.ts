import { NextRequest } from 'next/server';
import { z } from 'zod';
import { comandar, consultar, habilitado, limitarHttp, situacaoGeracao } from '@/lib/convites/service';
import { corpo, origemPublica, responder } from '@/lib/convites/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 150;
function processar(r: NextRequest, escrever: boolean) { return responder(async () => {
  habilitado();
  const token = r.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  const a = { tipo: 'cliente' as const, token };
  const geracao = r.nextUrl.searchParams.get('geracao');
  if (!escrever) return geracao === null ? consultar(a) : situacaoGeracao(a, z.uuid().parse(geracao));
  origemPublica(r);
  // Validação antes do rate limit evita gravar chaves arbitrárias de visitantes não autenticados.
  await consultar(a);
  await limitarHttp(`editor:${token}`, 80);
  return comandar(a, await corpo(r));
}); }
export function GET(r: NextRequest) { return processar(r, false); }
export function POST(r: NextRequest) { return processar(r, true); }
