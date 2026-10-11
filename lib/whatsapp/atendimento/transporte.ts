/**
 * Recusa definitiva: o Gupshup respondeu e não aceitou a mensagem (credencial, destino, app ou limite de taxa).
 * Nada foi enviado, então a mensagem termina FALHOU. Qualquer outra resposta (5xx, 408, corpo inválido, timeout)
 * é resultado incerto: a mensagem pode ter saído e não é reenviada automaticamente.
 */
const RECUSA_DEFINITIVA = new Set([400, 401, 403, 404, 413, 415, 422, 429]);

/**
 * Conteúdo de uma saída: texto, ou foto/vídeo/PDF (da mensagem pronta, lida do banco) com legenda opcional. A URL é a
 * externa da 081 ou a pública (https, com token) do arquivo próprio da 082; o PDF leva também o nome do arquivo.
 */
export type ConteudoSaida = { tipo: 'TEXTO'; texto: string } | { tipo: 'IMAGEM' | 'VIDEO'; url: string; legenda: string | null } | { tipo: 'DOCUMENTO'; url: string; nome: string; legenda: string | null };

/**
 * `message` da API de sessão (formato da documentação do Gupshup, "Message Type: Outbound (free form)", conferido em
 * 05/10/2026): texto {type,text}; foto {type,originalUrl,previewUrl,caption?} (previewUrl obrigatório: a mesma URL
 * serve); vídeo {type,url,caption?}; documento {type:"file",url,filename,caption?}. Legenda vazia não é enviada.
 */
export function mensagemGupshup(c: ConteudoSaida) {
  if (c.tipo === 'TEXTO') return { type: 'text', text: c.texto };
  const caption = c.legenda?.trim() ? { caption: c.legenda.trim() } : {};
  if (c.tipo === 'DOCUMENTO') return { type: 'file', url: c.url, filename: c.nome, ...caption };
  return c.tipo === 'IMAGEM' ? { type: 'image', originalUrl: c.url, previewUrl: c.url, ...caption } : { type: 'video', url: c.url, ...caption };
}
/**
 * Conteúdo a partir da linha da mensagem (060 + 081 + 082): mídia só quando a linha tem tipo E URL (externa ou, para o
 * arquivo próprio, a URL pública resolvida por quem chama: `url_arquivo`). Arquivo próprio sem URL pública (origem
 * https não configurada) é recusado antes da rede como transporte não configurado: nada sai e a mensagem termina FALHOU.
 * Linha sem mídia e sem texto é recusada da mesma forma.
 */
export function conteudoDaMensagem(m: { texto: string | null; midia_tipo?: string | null; midia_url?: string | null; midia_arquivo_id?: string | null; midia_nome?: string | null; url_arquivo?: string | null }): ConteudoSaida {
  const url = m.midia_url ?? m.url_arquivo ?? null;
  if (m.midia_arquivo_id && !m.url_arquivo) throw new Error('ATENDIMENTO_TRANSPORTE_NAO_CONFIGURADO');
  if ((m.midia_tipo === 'IMAGEM' || m.midia_tipo === 'VIDEO') && url) return { tipo: m.midia_tipo, url, legenda: m.texto };
  if (m.midia_tipo === 'DOCUMENTO' && url && m.midia_nome) return { tipo: 'DOCUMENTO', url, nome: m.midia_nome, legenda: m.texto };
  if (m.midia_tipo === 'DOCUMENTO') throw new Error('ATENDIMENTO_ENVIO_RECUSADO');
  if (!m.texto?.trim()) throw new Error('ATENDIMENTO_ENVIO_RECUSADO');
  return { tipo: 'TEXTO', texto: m.texto };
}

/** Mensagem de sessão (texto, foto ou vídeo) pela API v1 do Gupshup. O OTP usa o endpoint de template e não passa por aqui. */
export async function enviarMensagem(destination: string, conteudo: ConteudoSaida, buscar: typeof fetch = fetch) {
  const source = process.env.GUPSHUP_SOURCE?.replace(/^\+/, ''), key = process.env.GUPSHUP_API_KEY;
  if (!source || !/^\d{8,15}$/.test(source) || !key || !/^\d{8,15}$/.test(destination) || process.env.GUPSHUP_APP_NAME !== 'KidmaisManager') throw new Error('ATENDIMENTO_TRANSPORTE_NAO_CONFIGURADO');
  // Mídia só por https (a mesma regra do banco e da biblioteca); nada fora disso chega ao provedor.
  if (conteudo.tipo !== 'TEXTO' && !/^https:\/\/[^\s]+$/.test(conteudo.url)) throw new Error('ATENDIMENTO_TRANSPORTE_NAO_CONFIGURADO');
  const r = await buscar('https://api.gupshup.io/wa/api/v1/msg', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { apikey: key, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ channel: 'whatsapp', source, destination, 'src.name': 'KidmaisManager', message: JSON.stringify(mensagemGupshup(conteudo)) }) });
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
