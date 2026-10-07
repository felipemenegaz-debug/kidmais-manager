import { secretMatches } from '@/lib/integracoes/gupshup/webhook';
import { processarFilaAtendimento } from '@/app/api/admin/inteligencia/whatsapp/modelo';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  const segredo = process.env.WHATSAPP_ATENDIMENTO_WORKER_SECRET;
  if (!segredo || !/^[\x21-\x7e]{32,256}$/.test(segredo) || !secretMatches(request.headers.get('x-kidmais-worker-secret'), segredo)) return new Response(null, { status: 401 });
  const https = process.env.RENDER === 'true' ? request.headers.get('x-forwarded-proto') === 'https' : new URL(request.url).protocol === 'https:';
  if (!https) return new Response(null, { status: 403 });
  try { return Response.json(await processarFilaAtendimento(), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (erro) {
    // Só um código fixo vai ao log (nunca a mensagem do erro, que pode trazer dados): ATENDIMENTO_*, SQLSTATE ou o nome.
    const e = erro as { message?: unknown; code?: unknown; name?: unknown } | null;
    const codigo = typeof e?.message === 'string' && /^ATENDIMENTO_[A-Z_]+$/.test(e.message) ? e.message : typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? `SQLSTATE_${e.code}` : typeof e?.name === 'string' && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : 'DESCONHECIDO';
    console.error('[Atendimento WhatsApp] processador falhou: %s', codigo);
    return new Response(null, { status: 503 });
  }
}
