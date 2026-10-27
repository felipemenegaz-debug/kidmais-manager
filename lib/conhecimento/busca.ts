import { createHmac, timingSafeEqual } from "node:crypto";
import { visivel, type Corpus, type DocumentoConhecimento, type EscopoLeitor, type SecaoDocumento } from "./corpus.ts";

/**
 * Busca textual determinística em português (sem embeddings, sem reranking, sem modelo).
 * Ordem fixa: ACL + situação + vigência filtram ANTES do ranking; só então o índice pontua. Sem correspondência suficiente
 * ⇒ lista vazia (nunca texto inventado). Sem cache no MVP: cada consulta relê o corpus carregado no processo.
 */
const STOPWORDS = new Set((
  "a o as os um uma uns umas de da do das dos em na no nas nos por para pra com sem sob sobre e ou que se ao aos à às " +
  "como qual quais quando onde quem é ser são está estão foi era meu minha meus minhas seu sua seus suas eu voce vocês " +
  "voces me te lhe isso isto essa esse esta este ela ele elas eles mais menos muito muita ja já tem ter há ha pelo pela " +
  "pelos pelas num numa entre até ate também tambem so só nao não sim faz fazer posso pode podem consigo preciso"
).split(" ").map((p) => normalizar(p)));

export function normalizar(texto: string) {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Radical simples e previsível: plural regular e alguns sufixos verbais/nominais comuns. */
function radical(termo: string) {
  if (termo.length <= 3) return termo;
  for (const sufixo of ["coes", "soes", "mente", "ados", "adas", "ando", "endo", "indo", "cao", "sao", "ado", "ada", "ar", "er", "ir", "es", "s"]) {
    if (termo.endsWith(sufixo) && termo.length - sufixo.length >= 4) return termo.slice(0, -sufixo.length);
  }
  return termo;
}

export function termos(texto: string): string[] {
  return normalizar(texto).split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t)).map(radical);
}

export type Fragmento = { doc: DocumentoConhecimento; secao: SecaoDocumento };

type Pontuado = Fragmento & { pontos: number };

/** BM25 simplificado sobre título do documento (peso 2), título da seção (peso 2) e texto (peso 1). */
function pontuar(consulta: readonly string[], fragmentos: readonly Fragmento[]): Pontuado[] {
  const unicos = [...new Set(consulta)];
  const docs = fragmentos.map((f) => {
    const campos = [...termos(f.doc.titulo), ...termos(f.doc.titulo), ...termos(f.secao.titulo), ...termos(f.secao.titulo), ...termos(f.secao.texto)];
    const freq = new Map<string, number>();
    for (const t of campos) freq.set(t, (freq.get(t) ?? 0) + 1);
    return { f, freq, tamanho: campos.length };
  });
  const media = docs.reduce((s, d) => s + d.tamanho, 0) / Math.max(1, docs.length);
  const n = docs.length;
  const minimo = unicos.length <= 2 ? 1 : Math.ceil(unicos.length / 2);
  const resultado: Pontuado[] = [];
  for (const d of docs) {
    let pontos = 0;
    let cobertos = 0;
    for (const t of unicos) {
      const tf = d.freq.get(t) ?? 0;
      if (tf === 0) continue;
      cobertos += 1;
      const df = docs.filter((x) => x.freq.has(t)).length;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      pontos += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.tamanho / Math.max(1, media)))));
    }
    if (cobertos >= minimo && pontos > 0) resultado.push({ ...d.f, pontos });
  }
  return resultado.sort((a, b) => b.pontos - a.pontos || a.doc.id.localeCompare(b.doc.id) || a.secao.indice - b.secao.indice);
}

export function fragmentosVisiveis(corpus: Corpus, leitor: EscopoLeitor, hoje: string): Fragmento[] {
  return corpus.documentos.filter((doc) => visivel(doc, leitor, hoje)).flatMap((doc) => doc.secoes.map((secao) => ({ doc, secao })));
}

/** Trecho curto ao redor do primeiro termo encontrado (ou do início), sem cortar no meio de palavra quando possível. */
export function trechoDe(texto: string, consulta: readonly string[], max: number) {
  const limpo = texto.replace(/\s+/g, " ").trim();
  if (limpo.length <= max) return limpo;
  const norm = normalizar(limpo);
  let pos = -1;
  for (const t of consulta) {
    const i = norm.indexOf(t);
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  const inicio = Math.max(0, Math.min(pos < 0 ? 0 : pos - Math.floor(max / 4), limpo.length - max));
  const corte = limpo.slice(inicio, inicio + max);
  return `${inicio > 0 ? "…" : ""}${corte}${inicio + max < limpo.length ? "…" : ""}`;
}

export function buscar(corpus: Corpus, leitor: EscopoLeitor, hoje: string, consulta: string, limite: number): Pontuado[] {
  const q = termos(consulta);
  if (q.length === 0) return [];
  return pontuar(q, fragmentosVisiveis(corpus, leitor, hoje)).slice(0, limite);
}

// ---------------------------------------------------------------- referências opacas

/**
 * Referência opaca = payload assinado (HMAC-SHA256) com documento, seção, versão, EMPRESA da concessão e validade.
 * Não é segredo de acesso: o fetch revalida ACL, situação, vigência e versão. Adulterada, de outra empresa, expirada,
 * de versão substituída ou de documento retirado ⇒ a mesma resposta "não encontrado", sem revelar o motivo.
 */
type Payload = { d: string; s: number; v: number; e: string; x: number };

const b64 = (b: Buffer) => b.toString("base64url");

export function criarReferencia(segredo: string, f: Fragmento, empresaId: string, expiraEmS: number) {
  const corpo = b64(Buffer.from(JSON.stringify({ d: f.doc.id, s: f.secao.indice, v: f.doc.versao, e: empresaId, x: expiraEmS } satisfies Payload)));
  return `${corpo}.${b64(createHmac("sha256", segredo).update(`kidmais-conhecimento-v1.${corpo}`).digest())}`;
}

export function resolverReferencia(segredo: string, referencia: string, corpus: Corpus, leitor: EscopoLeitor, hoje: string, agoraS: number): Fragmento | null {
  if (referencia.length > 600 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(referencia)) return null;
  const [corpo, assinatura] = referencia.split(".");
  const esperada = createHmac("sha256", segredo).update(`kidmais-conhecimento-v1.${corpo}`).digest();
  const recebida = Buffer.from(assinatura, "base64url");
  if (recebida.length !== esperada.length || !timingSafeEqual(recebida, esperada)) return null;
  let p: Payload;
  try {
    p = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8")) as Payload;
  } catch {
    return null;
  }
  if (typeof p !== "object" || p === null || typeof p.d !== "string" || !Number.isInteger(p.s) || !Number.isInteger(p.v) || typeof p.e !== "string" || !Number.isInteger(p.x)) return null;
  if (p.e !== leitor.empresaId || p.x <= agoraS) return null;
  const doc = corpus.documentos.find((d) => d.id === p.d);
  if (!doc || doc.versao !== p.v || !visivel(doc, leitor, hoje)) return null;
  const secao = doc.secoes.find((s) => s.indice === p.s);
  return secao ? { doc, secao } : null;
}
