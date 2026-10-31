import { NextRequest } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { ambienteFesta } from '@/lib/festas/service';
import { comandar, consultar, habilitado, limitarHttp, situacaoGeracao } from '@/lib/convites/service';
import { corpo, responder } from '@/lib/convites/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 150;
function processar(r: NextRequest, escrever: boolean) { return responder(async () => {
  habilitado(); await ambienteFesta();
  const sessao = await exigirApiAdminCrmDisponivel(r);
  const alvo = z.union([
    z.object({ festaId: z.uuid(), conviteId: z.null() }).transform(x => ({ festaId: x.festaId })),
    z.object({ festaId: z.null(), conviteId: z.uuid() }).transform(x => ({ conviteId: x.conviteId })),
  ]).parse({ festaId: r.nextUrl.searchParams.get('festaId'), conviteId: r.nextUrl.searchParams.get('conviteId') });
  const a = { tipo: 'admin' as const, sessao, ...alvo };
  // Acompanhamento leve de um pedido (recarga, outra aba, conexão perdida): só a situação, sem imagens.
  const geracao = r.nextUrl.searchParams.get('geracao');
  if (!escrever) return geracao === null ? consultar(a) : situacaoGeracao(a, z.uuid().parse(geracao));
  await limitarHttp(`admin:${sessao.usuario_id}`, 120);
  const raw = await corpo(r);
  if (z.object({ acao: z.literal('criar') }).strict().safeParse(raw).success) return consultar(a, true);
  return comandar(a, raw);
}); }
export function GET(r: NextRequest) { return processar(r, false); }
export function POST(r: NextRequest) { return processar(r, true); }
