/**
 * Leitura determinística de valores em português do Brasil.
 * Só reconhece o que está escrito. Ambíguo ⇒ undefined (o motor pergunta), nunca uma suposição.
 */
const DIACRITICOS = /[̀-ͯ]/g;

export function normalizar(texto: string) {
  return texto.normalize("NFD").replace(DIACRITICOS, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** "4.500" | "4500" | "4.500,50" | "4500,5" | "4500.50" ⇒ centavos. */
function numeroParaCentavos(inteiroBruto: string, fracaoBruta?: string): number | undefined {
  const inteiro = inteiroBruto.replace(/\./g, "");
  if (!/^\d{1,9}$/.test(inteiro)) return undefined;
  const fracao = (fracaoBruta ?? "").padEnd(2, "0").slice(0, 2);
  return Number(inteiro) * 100 + Number(fracao || "0");
}

const DISPENSA_PRECO = /\b(sem (preco|valor)|depois|nao sei|definir depois|ainda nao|deixa (sem|pra depois))\b/;

/**
 * Preço em centavos; `null` quando o operador dispensou explicitamente ("sem preço", "depois")
 * em resposta à pergunta de preço; `undefined` quando não há preço no texto.
 */
export function extrairPrecoCentavos(texto: string, perguntado: boolean): number | null | undefined {
  const t = texto.replace(/\s+/g, " ");
  const n = normalizar(texto);
  if (perguntado && DISPENSA_PRECO.test(n)) return null;
  const mil = n.match(/(\d+(?:[.,]\d+)?)\s*mil\b/);
  if (mil) {
    const valor = Number(mil[1].replace(",", "."));
    if (Number.isFinite(valor) && valor > 0) return Math.round(valor * 1000 * 100);
  }
  const padroes = [
    /r\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?(?!\d)/i,
    /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\s*reais\b/i,
  ];
  for (const padrao of padroes) {
    const achado = t.match(padrao);
    if (achado) return numeroParaCentavos(achado[1], achado[2]);
  }
  if (perguntado) {
    const nu = t.trim().match(/^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/);
    if (nu) return numeroParaCentavos(nu[1], nu[2]);
    const ponto = t.trim().match(/^(\d+)\.(\d{1,2})$/);
    if (ponto) return numeroParaCentavos(ponto[1], ponto[2]);
  }
  return undefined;
}

/** Duração em minutos: "4 horas", "4h", "3h30", "3 horas e meia", "90 minutos". */
export function extrairDuracaoMinutos(texto: string, perguntado: boolean): number | undefined {
  const n = normalizar(texto);
  const hm = n.match(/(\d{1,2})\s*h(?:oras?|rs?)?\s*(?:e\s*)?(\d{1,2})\s*(?:min(?:utos)?)?\b/);
  if (hm && Number(hm[2]) < 60) return Number(hm[1]) * 60 + Number(hm[2]);
  const meia = n.match(/(\d{1,2})\s*h(?:oras?|rs?)?\s*e\s*meia\b/);
  if (meia) return Number(meia[1]) * 60 + 30;
  const decimal = n.match(/(\d{1,2})[.,]5\s*h(?:oras?|rs?)?\b/);
  if (decimal) return Number(decimal[1]) * 60 + 30;
  const horas = n.match(/(\d{1,2})\s*h(?:oras?|rs?)?\b/);
  if (horas) return Number(horas[1]) * 60;
  const minutos = n.match(/(\d{1,4})\s*min(?:utos)?\b/);
  if (minutos) return Number(minutos[1]);
  if (perguntado) {
    const nu = n.match(/^(\d{1,4})$/);
    if (nu) return Number(nu[1]) <= 24 ? Number(nu[1]) * 60 : Number(nu[1]);
  }
  return undefined;
}

/** Convidados mínimo/máximo. Um número isolado nunca vira os dois: só o que foi dito. */
export function extrairConvidados(texto: string, perguntado: "convidadosMinimos" | "convidadosMaximos" | null): { convidadosMinimos?: number; convidadosMaximos?: number } {
  const n = normalizar(texto);
  const faixa = n.match(/(?:de|entre)?\s*(\d{1,5})\s*(?:a|e|ate|-)\s*(\d{1,5})\s*(?:convidados?|pessoas?|criancas?)/)
    ?? (perguntado ? n.match(/^(?:de|entre)?\s*(\d{1,5})\s*(?:a|e|ate|-)\s*(\d{1,5})$/) : null);
  if (faixa) return { convidadosMinimos: Number(faixa[1]), convidadosMaximos: Number(faixa[2]) };
  const resultado: { convidadosMinimos?: number; convidadosMaximos?: number } = {};
  const minimo = n.match(/\bminimo\s*(?:de\s*)?(\d{1,5})/);
  const maximo = n.match(/\bmaximo\s*(?:de\s*)?(\d{1,5})/) ?? n.match(/\bate\s*(\d{1,5})\s*(?:convidados?|pessoas?)/);
  if (minimo) resultado.convidadosMinimos = Number(minimo[1]);
  if (maximo) resultado.convidadosMaximos = Number(maximo[1]);
  if (minimo || maximo) return resultado;
  if (perguntado) {
    const nu = n.match(/^(\d{1,5})(?:\s*(?:convidados?|pessoas?))?$/);
    if (nu) return { [perguntado]: Number(nu[1]) };
  }
  return resultado;
}

const APOS_NOME = /\s+(?:por|com|custando|no valor|valor|a partir|para|de r\$|de \d)\b|\s+r\$|[,;:!?]|\.(?:\s|$)|$/i;
const NAO_E_NOME = /^(?:por|com|de|no|na|para|custando|um|uma|o|a|novo|nova)$/i;

/** Nome do pacote em "pacote Festa Plus por R$ 4.500" ou entre aspas. */
export function extrairNomeAposPalavra(texto: string, palavra: string): string | undefined {
  const aspas = texto.match(new RegExp(`${palavra}\\s+(?:chamad[oa]\\s+|com o nome\\s+|de nome\\s+)?["“'‘]([^"”'’]{1,160})["”'’]`, "i"));
  if (aspas) return aspas[1].trim() || undefined;
  const inicio = texto.search(new RegExp(`\\b${palavra}\\s+`, "i"));
  if (inicio < 0) return undefined;
  let resto = texto.slice(inicio).replace(new RegExp(`^${palavra}\\s+(?:chamad[oa]\\s+|com o nome\\s+|de nome\\s+)?`, "i"), "");
  const primeira = resto.split(/\s+/)[0] ?? "";
  if (NAO_E_NOME.test(primeira)) return undefined;
  const fim = resto.search(APOS_NOME);
  resto = (fim >= 0 ? resto.slice(0, fim) : resto).trim();
  if (!resto || /r\$|\d{3,}/i.test(resto) || resto.length > 160) return undefined;
  return resto;
}

/** Resposta direta à pergunta "Qual o nome?": texto inteiro, sem pontuação final e sem prefixos comuns. */
export function nomeDaResposta(texto: string): string | undefined {
  const limpo = texto.trim().replace(/^["“'‘]|["”'’]$/g, "").replace(/^(?:o nome (?:e|é)|chama(?:-se)?|pode ser|nome:)\s*/i, "").replace(/[.!?]+$/, "").trim();
  return limpo && limpo.length <= 160 ? limpo : undefined;
}

export function extrairDescricao(texto: string): string | undefined {
  const achado = texto.match(/descri[cç][aã]o\s*[:=]\s*(.{1,2000})$/i);
  return achado ? achado[1].trim() : undefined;
}

/** Mesmo nome para o operador: sem acento, sem caixa, espaços simples. */
export function mesmoNome(a: string, b: string) {
  return normalizar(a) === normalizar(b);
}

export function reais(centavos: number) {
  const inteiro = Math.floor(centavos / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `R$ ${inteiro},${String(centavos % 100).padStart(2, "0")}`;
}

export function duracaoTexto(minutos: number) {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  if (!h) return `${m} min`;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h} ${h === 1 ? "hora" : "horas"}`;
}
