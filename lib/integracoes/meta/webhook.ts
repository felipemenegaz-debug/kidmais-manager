import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Webhook da WhatsApp Cloud API (Meta), o canal único do WhatsApp por empresa. Duas entradas:
 *  - GET: verificação da assinatura do webhook no painel da Meta (hub.mode=subscribe + hub.verify_token = o segredo
 *    META_WEBHOOK_VERIFY_TOKEN deste ambiente) → devolve hub.challenge;
 *  - POST: eventos assinados com X-Hub-Signature-256 (HMAC-SHA256 do corpo BRUTO com META_APP_SECRET). Sem assinatura
 *    válida nada é lido além do corpo; nada é gravado.
 * Este módulo não acessa banco nem rede: devolve os eventos já validados para quem persiste (a rota).
 * A Meta repete eventos que não recebem 200 por até 7 dias: só falha que um retry corrige (banco indisponível) vira 503.
 */
export const MAX_BODY_BYTES = 256 * 1024;
const BODY_TIMEOUT_MS = 3000;
export const SIGNATURE_HEADER = 'X-Hub-Signature-256';
type Environment = { META_APP_SECRET?: string; META_WEBHOOK_VERIFY_TOKEN?: string; KIDMAIS_DEPLOY_ENV?: string; RENDER?: string };

const response = (status: number, body: string | null = null) => new Response(body, { status, headers: { 'Cache-Control': 'no-store', ...(body ? { 'Content-Type': 'text/plain; charset=utf-8' } : {}) } });
const segredoValido = (v: string | undefined): v is string => !!v && /^[\x21-\x7e]{16,1024}$/.test(v);
const ambienteValido = (env: Environment) => env.KIDMAIS_DEPLOY_ENV === 'staging' || env.KIDMAIS_DEPLOY_ENV === 'production';
/** Atrás do Render o protocolo vem do proxy (confiável só com RENDER=true, como no webhook do Gupshup). */
function viaHttps(request: Request, env: Environment) {
  return env.RENDER === 'true' ? request.headers.get('x-forwarded-proto') === 'https' : new URL(request.url).protocol === 'https:';
}

export function tokenConfere(recebido: string | null, esperado: string) {
  if (!recebido || recebido.length > 1024) return false;
  const hash = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(hash(recebido), hash(esperado));
}

/** `sha256=<64 hex>` sobre os bytes exatos do corpo. Qualquer outro formato recusa. */
export function assinaturaConfere(corpo: Uint8Array, cabecalho: string | null, appSecret: string) {
  const m = /^sha256=([0-9a-f]{64})$/.exec(cabecalho ?? '');
  if (!m) return false;
  const esperado = createHmac('sha256', appSecret).update(corpo).digest();
  return timingSafeEqual(Buffer.from(m[1], 'hex'), esperado);
}

/** GET de verificação: só ecoa o challenge com o token exato deste ambiente. */
export function verificarWebhookMeta(request: Request, env: Environment): Response {
  if (!ambienteValido(env) || !segredoValido(env.META_WEBHOOK_VERIFY_TOKEN)) return response(503);
  if (!viaHttps(request, env)) return response(403);
  const url = new URL(request.url);
  const challenge = url.searchParams.get('hub.challenge') ?? '';
  if (url.searchParams.get('hub.mode') !== 'subscribe' || !tokenConfere(url.searchParams.get('hub.verify_token'), env.META_WEBHOOK_VERIFY_TOKEN)) return response(403);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(challenge)) return response(400);
  return response(200, challenge);
}

class BodyError extends Error {
  status: number;
  constructor(status: number) { super('Invalid body'); this.status = status; }
}
async function lerCorpoLimitado(request: Request): Promise<Uint8Array> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new BodyError(413);
  if (!request.body) throw new BodyError(400);
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BodyError(408)), BODY_TIMEOUT_MS); });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new BodyError(413);
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Mensagem recebida pelo número conectado `phoneNumberId` (da conta `wabaId`). `texto` null = conteúdo sem texto. */
export type EntradaMeta = { phoneNumberId: string; wabaId: string; id: string; contato: string; texto: string | null; timestamp: number; nomePerfil: unknown };
/** Status de uma mensagem enviada pelo número conectado. `sent` não muda nada no atendimento e não é devolvido. */
export type StatusMeta = { phoneNumberId: string; wabaId: string; id: string; tipo: 'delivered' | 'read' | 'failed' };
export type EventosMeta = { entradas: EntradaMeta[]; status: StatusMeta[] };

const idMeta = z.string().regex(/^[0-9]{1,32}$/);
const segundos = z.string().regex(/^[0-9]{1,12}$/);
const valorMensagens = z.object({
  messaging_product: z.literal('whatsapp'),
  metadata: z.object({ phone_number_id: idMeta }),
  contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.unknown() }).partial().optional().catch(undefined) })).max(100).optional().catch(undefined),
  messages: z.array(z.unknown()).max(100).optional(),
  statuses: z.array(z.unknown()).max(100).optional(),
});
const mensagem = z.object({ from: z.string().regex(/^\d{8,15}$/), id: z.string().min(1).max(512), timestamp: segundos, type: z.string().max(64), text: z.object({ body: z.unknown() }).optional().catch(undefined) });
const status = z.object({ id: z.string().min(1).max(512), status: z.string().max(32) });
const envelope = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(z.object({ id: idMeta, changes: z.array(z.object({ field: z.string(), value: z.unknown() })).max(100) })).min(1).max(100),
});

/**
 * Eventos de mensagem e status do envelope `whatsapp_business_account`. Outros campos (templates, qualidade, conta) e
 * itens fora do formato são ignorados um a um: um item malformado não derruba os outros nem faz a Meta repetir o lote.
 * Texto vazio ou acima de 4000 caracteres vira conteúdo sem texto (vai para a equipe, como no Gupshup).
 */
export function eventosMeta(valor: unknown): EventosMeta | null {
  const lido = envelope.safeParse(valor);
  if (!lido.success) return null;
  const eventos: EventosMeta = { entradas: [], status: [] };
  for (const entry of lido.data.entry) for (const change of entry.changes) {
    if (change.field !== 'messages') continue;
    const v = valorMensagens.safeParse(change.value);
    if (!v.success) continue;
    const phoneNumberId = v.data.metadata.phone_number_id, wabaId = entry.id;
    for (const item of v.data.messages ?? []) {
      const m = mensagem.safeParse(item);
      if (!m.success) continue;
      const corpo = m.data.type === 'text' && typeof m.data.text?.body === 'string' ? m.data.text.body.trim() : '';
      const nome = v.data.contacts?.find((c) => c.wa_id === m.data.from)?.profile?.name;
      eventos.entradas.push({ phoneNumberId, wabaId, id: m.data.id, contato: m.data.from, texto: corpo.length >= 1 && corpo.length <= 4000 ? corpo : null, timestamp: Number(m.data.timestamp) * 1000, nomePerfil: nome });
    }
    for (const item of v.data.statuses ?? []) {
      const s = status.safeParse(item);
      if (s.success && (s.data.status === 'delivered' || s.data.status === 'read' || s.data.status === 'failed')) eventos.status.push({ phoneNumberId, wabaId, id: s.data.id, tipo: s.data.status });
    }
  }
  return eventos;
}

/** Projeção sem conteúdo, contato nem identificadores para o log depois da resposta. */
export type ResumoMeta = { entradas: number; status: number };

/** POST: assinatura → corpo → eventos → persistência (opcional, só com a recepção ligada). Sem cookies nem sessão. */
export async function receberWebhookMeta(
  request: Request,
  env: Environment,
  registrarLog: (resumo: ResumoMeta) => void,
  persistir?: (eventos: EventosMeta) => Promise<void>,
): Promise<Response> {
  if (request.method !== 'POST') return response(405);
  if (!ambienteValido(env) || !segredoValido(env.META_APP_SECRET)) return response(503);
  if (!viaHttps(request, env)) return response(403);
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') return response(415);
  if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') return response(415);
  let corpo: Uint8Array;
  try { corpo = await lerCorpoLimitado(request); } catch (error) { return response(error instanceof BodyError ? error.status : 400); }
  if (!assinaturaConfere(corpo, request.headers.get(SIGNATURE_HEADER), env.META_APP_SECRET)) return response(401);
  let eventos: EventosMeta | null;
  try { eventos = eventosMeta(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(corpo))); } catch { return response(400); }
  if (!eventos) return response(400);
  if (persistir && (eventos.entradas.length || eventos.status.length)) {
    try { await persistir(eventos); } catch { return response(503); }
  }
  registrarLog({ entradas: eventos.entradas.length, status: eventos.status.length });
  return response(200);
}
