import { NextRequest } from 'next/server';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { ambienteFesta } from '@/lib/festas/service';
import { listarConvites, listarFestasParaConvite, operarBiblioteca } from '@/lib/convites/biblioteca';
import { habilitado, limitarHttp } from '@/lib/convites/service';
import { corpo, responder } from '@/lib/convites/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(r: NextRequest) { return responder(async () => {
  habilitado(); await ambienteFesta();
  const sessao = await exigirApiAdminCrmDisponivel(r);
  if (r.nextUrl.searchParams.get('festas') === 'true') return listarFestasParaConvite(sessao, r.nextUrl.searchParams.get('busca') ?? '');
  return listarConvites(sessao, { filtro: r.nextUrl.searchParams.get('filtro') ?? 'todos', pagina: r.nextUrl.searchParams.get('pagina') ?? 1 });
}); }
export function POST(r: NextRequest) { return responder(async () => {
  habilitado(); await ambienteFesta();
  const sessao = await exigirApiAdminCrmDisponivel(r);
  await limitarHttp(`admin:${sessao.usuario_id}`, 120);
  return operarBiblioteca(sessao, await corpo(r));
}); }
