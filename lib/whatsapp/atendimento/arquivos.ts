/**
 * Arquivos da biblioteca do atendimento (075): foto, vídeo e PDF enviados pela empresa e servidos por URL pública com
 * token. Funções puras (sem banco e sem rede), usadas pelo upload, pela rota pública e pelo transporte.
 *
 * Requisitos do provedor (Gupshup, "Message Type: Outbound (free form)", e Meta Cloud API, "Supported media types",
 * conferidos em 05/10/2026): foto JPG/JPEG/PNG até 5 MB; vídeo MP4/3GPP até 16 MB (H.264 + AAC); documento PDF até
 * 100 MB, nome até 240 caracteres. Limite DA APLICAÇÃO para PDF: 16 MB (o arquivo fica no banco; ver
 * docs/WALL_E_ATENDIMENTO.md). Codec de vídeo e perfil de cor da imagem só o provedor confere: não baixamos nem
 * transcodificamos mídia.
 *
 * O tipo vem dos PRIMEIROS BYTES do arquivo, nunca da extensão ou do content-type informados pelo navegador.
 */
export const TIPOS_ARQUIVO = ['IMAGEM', 'VIDEO', 'DOCUMENTO'] as const;
export type TipoArquivo = (typeof TIPOS_ARQUIVO)[number];

const MB = 1024 * 1024;
export const LIMITE_ARQUIVO: Record<TipoArquivo, number> = { IMAGEM: 5 * MB, VIDEO: 16 * MB, DOCUMENTO: 16 * MB };
export const LIMITE_NOME_ARQUIVO = 240;
export const NOME_TIPO_ARQUIVO: Record<TipoArquivo, string> = { IMAGEM: 'Foto', VIDEO: 'Vídeo', DOCUMENTO: 'PDF' };
export const REQUISITO_ARQUIVO: Record<TipoArquivo, string> = {
  IMAGEM: 'Foto JPG ou PNG, até 5 MB.',
  VIDEO: 'Vídeo MP4 ou 3GP (H.264 com áudio AAC), até 16 MB.',
  DOCUMENTO: 'PDF, até 16 MB.',
};

export type FormatoArquivo = { tipo: TipoArquivo; mime: string; extensao: string };

const comeca = (b: Uint8Array, assinatura: number[], deslocamento = 0) => b.length >= deslocamento + assinatura.length && assinatura.every((v, i) => b[deslocamento + i] === v);
const ascii = (b: Uint8Array, inicio: number, fim: number) => String.fromCharCode(...b.subarray(inicio, fim));

/** Formato real pelos primeiros bytes. PDF exige também a marca %%EOF no final (arquivo truncado é recusado). */
export function detectarFormato(bytes: Uint8Array): FormatoArquivo | null {
  if (comeca(bytes, [0xff, 0xd8, 0xff])) return { tipo: 'IMAGEM', mime: 'image/jpeg', extensao: 'jpg' };
  if (comeca(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { tipo: 'IMAGEM', mime: 'image/png', extensao: 'png' };
  if (comeca(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    const cauda = ascii(bytes, Math.max(0, bytes.length - 1024), bytes.length);
    return cauda.includes('%%EOF') ? { tipo: 'DOCUMENTO', mime: 'application/pdf', extensao: 'pdf' } : null;
  }
  // ISO BMFF: tamanho (4 bytes) + "ftyp" + marca principal.
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
    const marca = ascii(bytes, 8, 12);
    if (/^3g[gp]/.test(marca)) return { tipo: 'VIDEO', mime: 'video/3gpp', extensao: '3gp' };
    if (/^(isom|iso[2-9]|mp41|mp42|avc1|M4V |dash|mmp4)$/.test(marca)) return { tipo: 'VIDEO', mime: 'video/mp4', extensao: 'mp4' };
  }
  return null;
}

/**
 * Nome apresentável e seguro para o arquivo: só o nome (sem pastas), sem caracteres de controle, espaços colapsados, até
 * 240 caracteres INCLUINDO a extensão real (que substitui a informada). Nome vazio vira "arquivo".
 */
export function nomeArquivoSeguro(nomeInformado: string, extensao: string) {
  const base = String(nomeInformado ?? '').split(/[\\/]/).pop() ?? '';
  const semExtensao = base.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}"<>|:*?]/gu, ' ').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/\s+/gu, ' ').trim() || 'arquivo';
  const sufixo = `.${extensao}`;
  return Array.from(semExtensao).slice(0, LIMITE_NOME_ARQUIVO - sufixo.length).join('').trim() + sufixo;
}

export type ArquivoValidado = FormatoArquivo & { nome: string; tamanho: number };
/** Validação do upload. Erros como código estável (mensagem para a tela em MENSAGEM_ERRO_ARQUIVO). */
export function validarArquivo(nomeInformado: string, bytes: Uint8Array, tipoEsperado?: TipoArquivo): ArquivoValidado {
  if (!bytes.length) throw new Error('ARQUIVO_VAZIO');
  const formato = detectarFormato(bytes);
  if (!formato) throw new Error('ARQUIVO_FORMATO_NAO_ACEITO');
  if (tipoEsperado && formato.tipo !== tipoEsperado) throw new Error('ARQUIVO_TIPO_DIFERENTE');
  if (bytes.length > LIMITE_ARQUIVO[formato.tipo]) throw new Error('ARQUIVO_GRANDE_DEMAIS');
  return { ...formato, nome: nomeArquivoSeguro(nomeInformado, formato.extensao), tamanho: bytes.length };
}
export const MENSAGEM_ERRO_ARQUIVO: Record<string, string> = {
  ARQUIVO_VAZIO: 'O arquivo está vazio.',
  ARQUIVO_FORMATO_NAO_ACEITO: 'Formato não aceito. Envie foto JPG ou PNG, vídeo MP4 ou 3GP, ou PDF.',
  ARQUIVO_TIPO_DIFERENTE: 'O arquivo não é do tipo escolhido para esta mensagem.',
  ARQUIVO_GRANDE_DEMAIS: 'O arquivo passa do tamanho aceito (foto 5 MB, vídeo 16 MB, PDF 16 MB).',
};

/** Token da URL pública: 32 bytes aleatórios em base64url (43 caracteres). Conferido em tempo constante na rota. */
export const FORMATO_TOKEN_ARQUIVO = /^[A-Za-z0-9_-]{43}$/;

/**
 * Caminho público do arquivo. Termina no nome com a extensão real: o provedor e a validação de mídia exigem a extensão
 * no fim do caminho. O nome é decorativo (a rota confere id + token; o nome na URL não precisa coincidir).
 */
export function caminhoPublicoArquivo(arquivoId: string, token: string, nome: string) {
  return `/api/publico/atendimento/arquivos/${arquivoId}/${token}/${encodeURIComponent(nome)}`;
}

/**
 * URL pública absoluta para o provedor. Exige origem https (o provedor busca a mídia pela internet). Sem origem https
 * configurada devolve null: o transporte real recusa antes da rede (falha fechada) e a demonstração local mostra o
 * caminho que seria usado.
 */
export function urlPublicaArquivo(origem: string | undefined, arquivoId: string, token: string, nome: string) {
  if (!origem) return null;
  let u: URL;
  try { u = new URL(origem); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
  return new URL(caminhoPublicoArquivo(arquivoId, token, nome), u.origin).href;
}

/** Intervalo pedido pelo provedor (vídeo): "bytes=início-fim". Inválido ou múltiplo ⇒ null (resposta inteira). */
export function intervaloPedido(cabecalho: string | null, tamanho: number): { inicio: number; fim: number } | 'INVALIDO' | null {
  if (!cabecalho) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(cabecalho.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let inicio: number, fim: number;
  if (m[1] === '') { const n = Number(m[2]); if (!n) return 'INVALIDO'; inicio = Math.max(0, tamanho - n); fim = tamanho - 1; }
  else { inicio = Number(m[1]); fim = m[2] === '' ? tamanho - 1 : Math.min(Number(m[2]), tamanho - 1); }
  if (!Number.isSafeInteger(inicio) || !Number.isSafeInteger(fim) || inicio > fim || inicio >= tamanho) return 'INVALIDO';
  return { inicio, fim };
}
