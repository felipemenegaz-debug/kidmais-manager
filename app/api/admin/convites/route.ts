import { NextRequest } from 'next/server';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { ambienteFesta } from '@/lib/festas/service';
import { comandar, consultar, habilitado, limitarHttp } from '@/lib/convites/service';
import { corpo, responder } from '@/lib/convites/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 150;
function processar(r: NextRequest, escrever: boolean) { return responder(async () => {
  habilitado(); await ambienteFesta();
  const sessao = await exigirApiAdminCrmDisponivel(r);
  const festaId = z.uuid().parse(r.nextUrl.searchParams.get('festaId'));
  const a = { tipo: 'admin' as const, sessao, festaId };
  if (!escrever) return consultar(a);
  await limitarHttp(`admin:${sessao.usuario_id}`, 120);
  const raw = await corpo(r);
  if (z.object({ acao: z.literal('criar') }).strict().safeParse(raw).success) return consultar(a, true);
  return comandar(a, raw);
}); }
export function GET(r: NextRequest) { return processar(r, false); }
export function POST(r: NextRequest) { return processar(r, true); }
