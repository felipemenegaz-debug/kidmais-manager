/**
 * Recusa definitiva: o Gupshup respondeu e não aceitou a mensagem (credencial, destino, app ou limite de taxa).
 * Nada foi enviado, então a mensagem termina FALHOU. Qualquer outra resposta (5xx, 408, corpo inválido, timeout)
 * é resultado incerto: a mensagem pode ter saído e não é reenviada automaticamente.
 */
const RECUSA_DEFINITIVA = new Set([400, 401, 403, 404, 413, 415, 422, 429]);

/** Mensagem de sessão (texto) pela API v1 do Gupshup. O OTP usa o endpoint de template e não passa por aqui. */
export async function enviarMensagem(destination: string, texto: string, buscar: typeof fetch = fetch) {
  const source = process.env.GUPSHUP_SOURCE?.replace(/^\+/, ''), key = process.env.GUPSHUP_API_KEY;
  if (!source || !/^\d{8,15}$/.test(source) || !key || !/^\d{8,15}$/.test(destination) || process.env.GUPSHUP_APP_NAME !== 'KidmaisManager') throw new Error('ATENDIMENTO_TRANSPORTE_NAO_CONFIGURADO');
  const r = await buscar('https://api.gupshup.io/wa/api/v1/msg', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { apikey: key, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ channel: 'whatsapp', source, destination, 'src.name': 'KidmaisManager', message: JSON.stringify({ type: 'text', text: texto }) }) });
  if (RECUSA_DEFINITIVA.has(r.status)) { await r.body?.cancel().catch(() => {}); throw new Error('ATENDIMENTO_ENVIO_RECUSADO'); }
  const reader = r.body?.getReader();
  if (!reader) throw new Error('ATENDIMENTO_RESULTADO_INCERTO');
  let bytes = 0, body = ''; const decoder = new TextDecoder();
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 8192) { await reader.cancel(); throw new Error('ATENDIMENTO_RESULTADO_INCERTO'); } body += decoder.decode(chunk.value,{stream:true}); }
    body += decoder.decode();
  } finally { reader.releaseLock(); }
  const data = JSON.parse(body) as { status?: string; messageId?: string };
  // A documentação da API de sessão indica sucesso como qualquer 2xx (o exemplo usa 200), com status "submitted".
  if (r.status < 200 || r.status > 299 || data.status !== 'submitted' || typeof data.messageId !== 'string' || !data.messageId.length || data.messageId.length > 512) throw new Error('ATENDIMENTO_RESULTADO_INCERTO');
  return data.messageId;
}
