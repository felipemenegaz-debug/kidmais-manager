/**
 * Leitura limitada de multipart/form-data para o upload de documentos (H7).
 *
 * Não confia em Content-Length (pode faltar ou mentir): conta os bytes enquanto lê o stream e cancela
 * a leitura no primeiro byte acima do teto total. Só depois de ter o corpo inteiro dentro do teto é que
 * as partes são separadas, com limites próprios: número de partes, tamanho do cabeçalho de cada parte,
 * tamanho do arquivo e dos campos simples. Aceita exatamente uma parte de arquivo chamada "arquivo".
 *
 * Memória: no máximo `totalBytes` em pedaços + uma cópia contígua do mesmo tamanho na junção.
 * Nenhum `request.formData()` (que lê o corpo inteiro sem teto).
 */
export type LimitesMultipart = {
  /** Teto do corpo inteiro (arquivo + envelope). */
  totalBytes: number;
  /** Teto do arquivo. */
  arquivoBytes: number;
  /** Máximo de partes no corpo. */
  partes: number;
  /** Teto do bloco de cabeçalhos de cada parte. */
  cabecalhoBytes: number;
  /** Teto de cada campo que não é arquivo. */
  campoBytes: number;
};

export const FOLGA_ENVELOPE = 64 * 1024;

export function limitesUpload(arquivoBytes: number): LimitesMultipart {
  return { totalBytes: arquivoBytes + FOLGA_ENVELOPE, arquivoBytes, partes: 4, cabecalhoBytes: 4096, campoBytes: 1024 };
}

export type ArquivoMultipart = { nome: string; tipo: string; bytes: Uint8Array };

export type CodigoMultipart = "CORPO_GRANDE" | "ARQUIVO_GRANDE" | "PARTES_DEMAIS" | "CABECALHO_GRANDE" | "CAMPO_GRANDE" | "MULTIPART_INVALIDO" | "ARQUIVO_AUSENTE" | "LEITURA_LENTA" | "ENVIO_CANCELADO";

export type ResultadoMultipart =
  | { ok: true; arquivo: ArquivoMultipart }
  | { ok: false; codigo: CodigoMultipart; status: 400 | 408 | 413 };

const falha = (codigo: CodigoMultipart, status: 400 | 408 | 413 = 400): ResultadoMultipart => ({ ok: false, codigo, status });

/** Boundary de RFC 2046: 1 a 70 caracteres do conjunto permitido. */
export function boundaryDe(contentType: string | null): string | null {
  if (!contentType || !/^multipart\/form-data\s*;/i.test(contentType)) return null;
  const m = contentType.match(/;\s*boundary=(?:"([^"]{1,70})"|([0-9A-Za-z'()+_,\-./:=?]{1,70}))\s*(?:;|$)/i);
  return m ? (m[1] ?? m[2]) : null;
}

/**
 * Tempo de leitura (B1/H7): conexão lenta não segura um dos slots de upload. `prazoMs` limita a leitura
 * inteira; `ociosoMs`, o intervalo sem nenhum byte; `sinal` é o AbortSignal do pedido (cliente desconectou).
 */
export type TempoLeitura = { prazoMs: number; ociosoMs: number; sinal?: AbortSignal };
export const TEMPO_PADRAO: TempoLeitura = { prazoMs: 60_000, ociosoMs: 10_000 };

export type Leitura = Uint8Array | "GRANDE" | "LENTA" | "CANCELADA";

const ESGOTOU = Symbol("esgotou");
const CANCELOU = Symbol("cancelou");

/** Espera um `read()` com teto de tempo e cancelamento, sem deixar timer nem listener para trás. */
function esperarLeitura<T>(leitura: Promise<T>, ms: number, sinal?: AbortSignal): Promise<T | typeof ESGOTOU | typeof CANCELOU> {
  return new Promise((resolve, reject) => {
    if (sinal?.aborted) { resolve(CANCELOU); return; }
    const aoCancelar = () => { clearTimeout(timer); resolve(CANCELOU); };
    const timer = setTimeout(() => { sinal?.removeEventListener("abort", aoCancelar); resolve(ESGOTOU); }, Math.max(0, ms));
    sinal?.addEventListener("abort", aoCancelar, { once: true });
    leitura.then(
      (v) => { clearTimeout(timer); sinal?.removeEventListener("abort", aoCancelar); resolve(v); },
      (e) => { clearTimeout(timer); sinal?.removeEventListener("abort", aoCancelar); reject(e); },
    );
  });
}

/**
 * Lê o stream até o teto de bytes, dentro do prazo total e do tempo ocioso. Acima do teto, fora do
 * tempo ou com o pedido cancelado, cancela o leitor e devolve o motivo — nunca espera indefinidamente.
 */
export async function lerLimitado(corpo: ReadableStream<Uint8Array> | null, teto: number, tempo: TempoLeitura = TEMPO_PADRAO): Promise<Leitura> {
  if (!corpo) return new Uint8Array(0);
  const leitor = corpo.getReader();
  const pedacos: Uint8Array[] = [];
  const limite = Date.now() + tempo.prazoMs;
  let total = 0;
  const parar = async (motivo: "GRANDE" | "LENTA" | "CANCELADA"): Promise<Leitura> => {
    const cancelamento = leitor.cancel(motivo).catch(() => undefined);
    // Sem leitura pendente (GRANDE) o cancelamento é imediato: espera, para não puxar outro pedaço.
    // Com leitura pendente (LENTA/CANCELADA) não espera uma fonte que pode nunca responder.
    if (motivo === "GRANDE") await cancelamento;
    return motivo;
  };
  try {
    for (;;) {
      const restante = limite - Date.now();
      if (restante <= 0) return await parar("LENTA");
      const r = await esperarLeitura(leitor.read(), Math.min(tempo.ociosoMs, restante), tempo.sinal);
      if (r === ESGOTOU) return await parar("LENTA");
      if (r === CANCELOU) return await parar("CANCELADA");
      if (r.done) break;
      total += r.value.byteLength;
      if (total > teto) return await parar("GRANDE");
      pedacos.push(r.value);
    }
  } finally {
    try { leitor.releaseLock(); } catch { /* leitura pendente já cancelada */ }
  }
  const junto = new Uint8Array(total);
  let pos = 0;
  for (const p of pedacos) { junto.set(p, pos); pos += p.byteLength; }
  return junto;
}

const CRLF = Buffer.from("\r\n");
const FIM_CABECALHO = Buffer.from("\r\n\r\n");

function parametro(cabecalho: string, nome: string): string | null {
  const m = cabecalho.match(new RegExp(`;\\s*${nome}="([^"\\r\\n]{0,255})"`, "i"));
  return m ? m[1] : null;
}

/** Separa as partes de um corpo já limitado. Linear: cada busca começa onde a anterior terminou. */
export function separarPartes(corpo: Uint8Array, boundary: string, limites: LimitesMultipart): ResultadoMultipart {
  const dados = Buffer.from(corpo.buffer, corpo.byteOffset, corpo.byteLength);
  const delimitador = Buffer.from(`--${boundary}`);
  const proximo = Buffer.from(`\r\n--${boundary}`);
  let pos = dados.indexOf(delimitador);
  if (pos !== 0) return falha("MULTIPART_INVALIDO");
  pos += delimitador.length;
  let arquivo: ArquivoMultipart | null = null;
  let partes = 0;
  for (;;) {
    // Depois do delimitador: "--" encerra; CRLF abre uma parte.
    if (dados[pos] === 0x2d && dados[pos + 1] === 0x2d) break;
    if (!dados.subarray(pos, pos + 2).equals(CRLF)) return falha("MULTIPART_INVALIDO");
    pos += 2;
    partes += 1;
    if (partes > limites.partes) return falha("PARTES_DEMAIS", 413);
    const fimCabecalho = dados.indexOf(FIM_CABECALHO, pos);
    if (fimCabecalho < 0) return falha("MULTIPART_INVALIDO");
    if (fimCabecalho - pos > limites.cabecalhoBytes) return falha("CABECALHO_GRANDE", 413);
    const cabecalho = dados.subarray(pos, fimCabecalho).toString("latin1");
    const inicio = fimCabecalho + FIM_CABECALHO.length;
    const fim = dados.indexOf(proximo, inicio);
    if (fim < 0) return falha("MULTIPART_INVALIDO");
    const disposicao = cabecalho.split("\r\n").find((l) => /^content-disposition:/i.test(l)) ?? "";
    if (!/^content-disposition:\s*form-data\s*;/i.test(disposicao)) return falha("MULTIPART_INVALIDO");
    const nome = parametro(disposicao, "name");
    const nomeArquivo = parametro(disposicao, "filename");
    const tamanho = fim - inicio;
    if (nomeArquivo !== null) {
      if (nome !== "arquivo" || arquivo) return falha("MULTIPART_INVALIDO");
      if (tamanho > limites.arquivoBytes) return falha("ARQUIVO_GRANDE", 413);
      const tipo = cabecalho.split("\r\n").find((l) => /^content-type:/i.test(l))?.replace(/^content-type:\s*/i, "").trim().slice(0, 100) ?? "";
      // Cópia do trecho: o arquivo não segura o corpo inteiro vivo.
      arquivo = { nome: Buffer.from(nomeArquivo, "latin1").toString("utf8"), tipo, bytes: new Uint8Array(dados.subarray(inicio, fim)) };
    } else if (tamanho > limites.campoBytes) {
      return falha("CAMPO_GRANDE", 413);
    }
    pos = fim + proximo.length;
  }
  return arquivo ? { ok: true, arquivo } : falha("ARQUIVO_AUSENTE");
}

export async function lerMultipartLimitado(corpo: ReadableStream<Uint8Array> | null, contentType: string | null, limites: LimitesMultipart, tempo: TempoLeitura = TEMPO_PADRAO): Promise<ResultadoMultipart> {
  const boundary = boundaryDe(contentType);
  if (!boundary) return falha("MULTIPART_INVALIDO");
  const lido = await lerLimitado(corpo, limites.totalBytes, tempo);
  if (lido === "GRANDE") return falha("CORPO_GRANDE", 413);
  if (lido === "LENTA") return falha("LEITURA_LENTA", 408);
  if (lido === "CANCELADA") return falha("ENVIO_CANCELADO", 400);
  return separarPartes(lido, boundary, limites);
}

/** Semáforo por processo: limita uploads simultâneos (cada um pode segurar até `totalBytes`). */
export function criarSemaforo(maximo: number) {
  let ocupados = 0;
  return {
    tentar(): (() => void) | null {
      if (ocupados >= maximo) return null;
      ocupados += 1;
      let liberado = false;
      return () => { if (!liberado) { liberado = true; ocupados -= 1; } };
    },
    get ocupados() { return ocupados; },
  };
}
