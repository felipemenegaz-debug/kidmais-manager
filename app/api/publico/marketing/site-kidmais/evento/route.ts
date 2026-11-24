import type { NextRequest } from 'next/server';
import { db } from '@/lib/db/postgres';
import { limitarPublico } from '@/lib/http/limite-publico';
import { empresaDoSiteKidmais, ID_CAMPANHA, registrarCliqueSiteKidmais, SITE_KIDMAIS } from '@/lib/marketing/site-kidmais';

export async function POST(request: NextRequest) {
  const origem = request.headers.get('origin');
  if (origem !== SITE_KIDMAIS && origem !== 'https://www.kidmaisfestas.com') return new Response(null, { status: 403 });
  const empresa = empresaDoSiteKidmais();
  if (!empresa) return new Response(null, { status: 404 });
  const params = request.nextUrl.searchParams;
  const ids = params.getAll('campanha');
  const eventos = params.getAll('evento');
  const evento = eventos[0];
  if (ids.length !== 1 || !ID_CAMPANHA.test(ids[0]) || eventos.length !== 1 ||
      (evento !== 'visita' && evento !== 'whatsapp')) return new Response(null, { status: 400 });
  const limite = await limitarPublico(request, 'LEITURA');
  if (limite) return limite;
  await registrarCliqueSiteKidmais(db(), empresa, ids[0], evento === 'visita' ? 'CLIQUE_LINK_CAMPANHA' : 'CLIQUE_WHATSAPP');
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': origem, Vary: 'Origin' } });
}
