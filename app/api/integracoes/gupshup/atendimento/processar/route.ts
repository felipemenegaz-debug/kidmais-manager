import { secretMatches } from '@/lib/integracoes/gupshup/webhook';
import { processarFilaAtendimento } from '@/app/api/admin/inteligencia/whatsapp/modelo';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  const segredo = process.env.WHATSAPP_ATENDIMENTO_WORKER_SECRET;
  if (!segredo || !/^[\x21-\x7e]{32,256}$/.test(segredo) || !secretMatches(request.headers.get('x-kidmais-worker-secret'), segredo)) return new Response(null, { status: 401 });
  const https = process.env.RENDER === 'true' ? request.headers.get('x-forwarded-proto') === 'https' : new URL(request.url).protocol === 'https:';
  if (!https) return new Response(null, { status: 403 });
  try { return Response.json(await processarFilaAtendimento(), { headers: { 'Cache-Control': 'no-store' } }); } catch { return new Response(null, { status: 503 }); }
}
