import { secretMatches } from '@/lib/integracoes/gupshup/webhook';
import { executarRetencao } from '@/lib/whatsapp/atendimento/privacidade';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Rotina de retenção do atendimento (D2, 12/10/2026): segredo PRÓPRIO (WHATSAPP_ATENDIMENTO_RETENCAO_SECRET; B4 da revisão
 * de 69dc301 — não depende do segredo do processador, que só existe com o canal configurado) e HTTPS, INDEPENDENTE das chaves
 * do canal (WHATSAPP_ATENDIMENTO_ENABLED) e da IA (chave-mestra lida só em lib/inteligencia/flags.ts): dado vencido é
 * apagado mesmo com o atendimento desligado. Sem empresa com prazo definido, nada é apagado. Cada execução fica registrada no banco
 * (whatsapp_atendimento_retencao_execucoes); o log só leva o código (nunca conteúdo).
 */
export async function POST(request: Request) {
  const segredo = process.env.WHATSAPP_ATENDIMENTO_RETENCAO_SECRET;
  if (!segredo || !/^[\x21-\x7e]{32,256}$/.test(segredo) || !secretMatches(request.headers.get('x-kidmais-worker-secret'), segredo)) return new Response(null, { status: 401 });
  const https = process.env.RENDER === 'true' ? request.headers.get('x-forwarded-proto') === 'https' : new URL(request.url).protocol === 'https:';
  if (!https) return new Response(null, { status: 403 });
  try { return Response.json(await executarRetencao(), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (erro) {
    const e = erro as { message?: unknown; code?: unknown } | null;
    const codigo = typeof e?.message === 'string' && /^ATENDIMENTO_[A-Z_]+$/.test(e.message) ? e.message : typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? `SQLSTATE_${e.code}` : 'ERRO_INTERNO';
    console.error('[Atendimento WhatsApp] retenção falhou: %s', codigo);
    return new Response(null, { status: 503 });
  }
}
