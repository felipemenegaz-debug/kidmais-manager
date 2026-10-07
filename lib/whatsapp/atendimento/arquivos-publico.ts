import { timingSafeEqual } from 'node:crypto';
import { db } from '../../db/postgres.ts';
import { ambienteAtendimento } from './configuracao.ts';
import { FORMATO_TOKEN_ARQUIVO, intervaloPedido } from './arquivos.ts';

/**
 * Leitura pública de um arquivo da biblioteca (075) para o provedor baixar a mídia sem sessão: id + token aleatório de
 * 32 bytes (conferido em tempo constante), só no ambiente deste servidor. Sem a 075, id/token fora do formato ou token
 * divergente: "não encontrado" (nada revela se o id existe). Arquivar a mensagem pronta não apaga o arquivo: o que já
 * saiu continua no histórico; novos usos são barrados na biblioteca e no envio.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type ArquivoPublico = { mime: string; nome: string; tamanho: number; sha256: string; conteudo: Buffer };
export async function lerArquivoPublico(id: string, token: string): Promise<ArquivoPublico | null> {
  if (!UUID.test(id) || !FORMATO_TOKEN_ARQUIVO.test(token)) return null;
  let ambiente: string;
  try { ambiente = ambienteAtendimento(); } catch { return null; }
  try {
    const a = (await db().query<{ token: string; mime: string; nome: string; tamanho_bytes: number; sha256: string; conteudo: Buffer }>(
      'SELECT token,mime,nome,tamanho_bytes,sha256,conteudo FROM whatsapp_atendimento_arquivos WHERE id=$1 AND ambiente=$2', [id, ambiente])).rows[0];
    if (!a || a.token.length !== token.length || !timingSafeEqual(Buffer.from(a.token), Buffer.from(token))) return null;
    return { mime: a.mime, nome: a.nome, tamanho: Number(a.tamanho_bytes), sha256: a.sha256, conteudo: a.conteudo };
  } catch (erro) {
    if ((erro as { code?: string }).code === '42P01') return null;
    throw erro;
  }
}

/** Resposta HTTP do arquivo: inteiro, ou o intervalo pedido (vídeo); cabeçalhos que impedem execução no navegador. */
export function respostaArquivo(a: ArquivoPublico | null, range: string | null, head: boolean) {
  const base = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'private, max-age=300' };
  if (!a) return new Response(head ? null : 'Arquivo não encontrado.', { status: 404, headers: { ...base, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  const headers: Record<string, string> = {
    ...base, 'Content-Type': a.mime, 'Accept-Ranges': 'bytes', ETag: `"${a.sha256}"`,
    'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(a.nome)}`,
  };
  const intervalo = intervaloPedido(range, a.tamanho);
  if (intervalo === 'INVALIDO') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${a.tamanho}` } });
  const corpo = intervalo ? a.conteudo.subarray(intervalo.inicio, intervalo.fim + 1) : a.conteudo;
  const extra: Record<string, string> = intervalo ? { 'Content-Range': `bytes ${intervalo.inicio}-${intervalo.fim}/${a.tamanho}` } : {};
  return new Response(head ? null : new Uint8Array(corpo), { status: intervalo ? 206 : 200, headers: { ...headers, ...extra, 'Content-Length': String(corpo.length) } });
}
