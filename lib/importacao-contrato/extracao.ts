import { z } from "zod";
import { lerDinheiro, soDigitos, tokensDinheiro, validarCpf, validarData, validarInteiro, validarTelefone, validarValor, type TipoCampo } from "./validadores.ts";

/**
 * Schema da extração de contrato histórico (Fase 13).
 *
 * Cada campo traz o valor como aparece no documento, a página e um trecho curto que prova a leitura.
 * NÃO existe campo de pagamento realizado: o contrato só mostra o combinado. "Previsto ≠ pago".
 * O schema é estrito: chave desconhecida (ex.: "pago", "tenant", "confirmar") invalida a extração inteira.
 */
export const SCHEMA_VERSAO = 1;

const campo = z.object({
  valor: z.string().trim().max(500).nullable(),
  pagina: z.number().int().min(1).max(200).nullable(),
  trecho: z.string().max(300).nullable(),
}).strict();

export type CampoLido = z.infer<typeof campo>;

export const extracaoSchema = z.object({
  contratante: z.object({ nome: campo, cpf: campo, telefone: campo, whatsapp: campo, email: campo }).strict(),
  evento: z.object({ data: campo, horario: campo, duracao: campo, aniversariante: campo, idade: campo, convidados: campo, tema: campo }).strict(),
  pacote: z.object({ nome: campo, duracao: campo, quantidade: campo, itens: campo }).strict(),
  buffet: z.object({ itens: campo, observacoes: campo, restricoes: campo }).strict(),
  valores: z.object({ preco: campo, adicionais: campo, total: campo }).strict(),
  pagamentoPrevisto: z.object({
    entrada: campo,
    entradaVencimento: campo,
    condicao: campo,
    parcelas: z.array(z.object({ numero: z.number().int().min(1).max(60), valor: campo, vencimento: campo }).strict()).max(60),
  }).strict(),
  observacoes: campo,
}).strict();

export type ExtracaoLida = z.infer<typeof extracaoSchema>;

const jsonCampo = {
  type: "object",
  additionalProperties: false,
  required: ["valor", "pagina", "trecho"],
  properties: { valor: { type: ["string", "null"] }, pagina: { type: ["integer", "null"] }, trecho: { type: ["string", "null"] } },
} as const;

function grupo(chaves: readonly string[]) {
  return { type: "object", additionalProperties: false, required: [...chaves], properties: Object.fromEntries(chaves.map((c) => [c, jsonCampo])) };
}

/** Mesmo schema em JSON Schema, para saída estruturada do provedor. Testado contra o zod. */
export const EXTRACAO_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["contratante", "evento", "pacote", "buffet", "valores", "pagamentoPrevisto", "observacoes"],
  properties: {
    contratante: grupo(["nome", "cpf", "telefone", "whatsapp", "email"]),
    evento: grupo(["data", "horario", "duracao", "aniversariante", "idade", "convidados", "tema"]),
    pacote: grupo(["nome", "duracao", "quantidade", "itens"]),
    buffet: grupo(["itens", "observacoes", "restricoes"]),
    valores: grupo(["preco", "adicionais", "total"]),
    pagamentoPrevisto: {
      type: "object",
      additionalProperties: false,
      required: ["entrada", "entradaVencimento", "condicao", "parcelas"],
      properties: {
        entrada: jsonCampo,
        entradaVencimento: jsonCampo,
        condicao: jsonCampo,
        parcelas: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["numero", "valor", "vencimento"], properties: { numero: { type: "integer" }, valor: jsonCampo, vencimento: jsonCampo } },
        },
      },
    },
    observacoes: jsonCampo,
  },
} as const;

export const VAZIO: CampoLido = { valor: null, pagina: null, trecho: null };

export function extracaoVazia(): ExtracaoLida {
  return {
    contratante: { nome: VAZIO, cpf: VAZIO, telefone: VAZIO, whatsapp: VAZIO, email: VAZIO },
    evento: { data: VAZIO, horario: VAZIO, duracao: VAZIO, aniversariante: VAZIO, idade: VAZIO, convidados: VAZIO, tema: VAZIO },
    pacote: { nome: VAZIO, duracao: VAZIO, quantidade: VAZIO, itens: VAZIO },
    buffet: { itens: VAZIO, observacoes: VAZIO, restricoes: VAZIO },
    valores: { preco: VAZIO, adicionais: VAZIO, total: VAZIO },
    pagamentoPrevisto: { entrada: VAZIO, entradaVencimento: VAZIO, condicao: VAZIO, parcelas: [] },
    observacoes: VAZIO,
  };
}

// ---------------------------------------------------------------- evidência

export function normalizarTrecho(texto: string) {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Frase delimitada: não vale como pedaço de outra palavra ou número ("30" não está em "130"). */
function contemDelimitado(texto: string, frase: string) {
  if (!frase) return false;
  const escapada = frase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapada}(?![\\p{L}\\p{N}])`, "u").test(texto);
}

const CPF_NO_TEXTO = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g;
const TELEFONE_NO_TEXTO = /(?<!\d)(?:\+?55\s*)?\(?\d{2}\)?\s*\d{4,5}[\s-]?\d{4}(?!\d)/g;
const DATA_NO_TEXTO = /(?<!\d)\d{1,2}[/.-]\d{1,2}[/.-]\d{4}(?!\d)|(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)|(?<!\d)\d{1,2} de [a-z]+ de \d{4}(?!\d)/g;
// Sinal faz parte do número: "30" nunca é provado por "-30".
const INTEIRO_NO_TEXTO = /(?<![\d.,+-])\d+(?!\d|[.,]\d)/g;
const telefoneCanonico = (t: string) => { const d = soDigitos(t); return d.length >= 12 && d.startsWith("55") ? d.slice(2) : d; };

/**
 * Comparação tipada entre o valor lido e o trecho (H5): dinheiro por igualdade numérica completa, CPF e
 * telefone canônicos, data pelo parser de data, número por token inteiro, texto delimitado.
 * Valor que o validador recusa só confere como frase delimitada do texto bruto.
 */
export function valorNoTrecho(valorLido: string, trechoNormalizado: string, tipo: TipoCampo): boolean {
  const valor = normalizarTrecho(valorLido);
  const tokens = (re: RegExp) => trechoNormalizado.match(re) ?? [];
  switch (tipo) {
    case "valor": {
      const v = validarValor(valor);
      if (!v.ok) break;
      return tokensDinheiro(trechoNormalizado).some((t) => { const x = lerDinheiro(t); return x.ok && x.valor === v.valor; });
    }
    case "cpf": {
      const v = validarCpf(valor);
      if (!v.ok) break;
      return tokens(CPF_NO_TEXTO).some((t) => soDigitos(t) === soDigitos(v.valor));
    }
    case "telefone": {
      const v = validarTelefone(valor);
      if (!v.ok) break;
      return tokens(TELEFONE_NO_TEXTO).some((t) => telefoneCanonico(t) === soDigitos(v.valor));
    }
    case "data": {
      const v = validarData(valor);
      if (!v.ok) break;
      return tokens(DATA_NO_TEXTO).some((t) => { const x = validarData(t); return x.ok && x.valor === v.valor; });
    }
    case "idade":
    case "convidados":
    case "quantidade": {
      const v = validarInteiro(valor, 0, 10000, "Número");
      if (!v.ok) break;
      return tokens(INTEIRO_NO_TEXTO).some((t) => Number(t) === v.valor);
    }
    default:
      break;
  }
  return contemDelimitado(trechoNormalizado, valor);
}

/**
 * A evidência só vale se o trecho existe na página indicada (ou em alguma página, se a página não veio)
 * e contém o valor lido, comparado pelo tipo do campo. Assim um valor inventado pelo modelo nunca
 * aparece como "Encontrado", nem "100" é provado por um trecho com "1000".
 */
export function evidenciaConfere(lido: CampoLido, paginas: readonly string[], tipo: TipoCampo): boolean {
  return localizarEvidencia(lido, paginas, tipo) !== null;
}

/** Onde a evidência está na página ORIGINAL (offsets no texto extraído da página, fim exclusivo). */
export type Localizacao = { pagina: number; inicio: number; fim: number };

/** Normalização com mapa de volta para a posição original de cada caractere. */
function normalizarComMapa(texto: string): { texto: string; mapa: number[] } {
  let saida = "";
  const mapa: number[] = [];
  let espaco = false;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (/\s/.test(c)) {
      if (!espaco && saida.length) { saida += " "; mapa.push(i); }
      espaco = true;
      continue;
    }
    espaco = false;
    for (const b of c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()) { saida += b; mapa.push(i); }
  }
  if (saida.endsWith(" ")) { saida = saida.slice(0, -1); mapa.pop(); }
  return { texto: saida, mapa };
}

const ALFANUM = /[\p{L}\p{N}]/u;
const DIGITO = /\d/;

/**
 * O trecho começa e termina em fronteira de token NA PÁGINA: não corta palavra ("Ana" em "Mariana"),
 * número ("R$ 100" em "R$ 1000", CPF parcial) nem separa o sinal do número ("30" em "-30").
 */
function fronteirasValidas(pagina: string, inicio: number, fim: number) {
  const primeiro = pagina[inicio];
  const antes = pagina[inicio - 1];
  const ultimo = pagina[fim - 1];
  const depois = pagina[fim];
  if (antes !== undefined) {
    if (ALFANUM.test(antes) && ALFANUM.test(primeiro)) return false;
    if (DIGITO.test(primeiro) && /[-+.,]/.test(antes)) return false;
  }
  if (depois !== undefined) {
    if (ALFANUM.test(ultimo) && ALFANUM.test(depois)) return false;
    if (DIGITO.test(ultimo) && /[.,]/.test(depois) && DIGITO.test(pagina[fim + 1] ?? "")) return false;
  }
  return true;
}

/**
 * Localizador estruturado (H5): o trecho tem de existir na página com fronteiras de token válidas nas
 * duas pontas, e o valor tem de aparecer DENTRO desse recorte como token completo do tipo do campo.
 * Não aceita evidência construída por substring arbitrária. Devolve os offsets na página original.
 */
export function localizarEvidencia(lido: CampoLido, paginas: readonly string[], tipo: TipoCampo): Localizacao | null {
  if (!lido.valor || !lido.trecho) return null;
  const trecho = normalizarTrecho(lido.trecho);
  if (trecho.length < 3) return null;
  const indices = lido.pagina ? [lido.pagina - 1] : paginas.map((_, i) => i);
  for (const i of indices) {
    const original = paginas[i];
    if (original === undefined) continue;
    const { texto, mapa } = normalizarComMapa(original);
    let tentativas = 0;
    for (let pos = texto.indexOf(trecho); pos >= 0 && tentativas < 64; pos = texto.indexOf(trecho, pos + 1), tentativas += 1) {
      const fim = pos + trecho.length;
      if (!fronteirasValidas(texto, pos, fim)) continue;
      if (!valorNoTrecho(lido.valor, texto.slice(pos, fim), tipo)) continue;
      return { pagina: i + 1, inicio: mapa[pos], fim: mapa[fim - 1] + 1 };
    }
  }
  return null;
}

// ---------------------------------------------------------------- extrator por regras (sem rede)

type Regra = { caminho: string; padrao: RegExp; grupo?: number };

/**
 * CAPTURA RAW → PARSE → VALIDAÇÃO (H4). As regras capturam o token INTEIRO como está no texto — sinal,
 * "menos", moeda, separadores e palavra de escala ("mil", "milhões", "k") — e só o validador decide.
 * Nunca "-30" vira 30, "R$ -100,00" some ou "30 mil" vira 30.
 */
const SINAL = "(?:menos\\s+|-\\s*)?";
const ESCALA = "(?:\\s*(?:mil|milh(?:ão|ao|ões|oes)|k)\\b)?";
const DINHEIRO = `(${SINAL}(?:R\\$\\s*)?-?\\s*\\d[\\d.,]{0,20}${ESCALA})`;
const DINHEIRO_FRASE = `(${SINAL}(?:R\\$\\s*)?-?\\s*\\d(?:[\\d.,]{0,19}\\d)?${ESCALA})`;
const NUMERO = `(${SINAL}\\d[\\d.,]{0,12}${ESCALA})`;
const ROTULO = "\\s*[:\\-–]\\s*";
const REGRAS: readonly Regra[] = [
  { caminho: "contratante.nome", padrao: new RegExp(`(?:contratante|nome do contratante|nome do cliente)${ROTULO}([^\\n,;]{3,120}?)(?=\\s+(?:de\\s+)?CPF\\b|[\\n,;]|$)`, "i") },
  { caminho: "contratante.cpf", padrao: /(?:contratante\s*[:\-–][\s\S]{0,160}?\bCPF\s*(?:n[ºo°.]\s*)?[:\-–]?\s*)(\d{3}\.?\d{3}\.?\d{3}-?\d{2})\b/i },
  { caminho: "contratante.whatsapp", padrao: /whats\s*app\s*[:\-–]?\s*(\(?\d{2}\)?\s*9?\s?\d{4}[\s-]?\d{4})/i },
  { caminho: "contratante.telefone", padrao: /(?:telefone|tel\.?|celular|fone)\s*[:\-–]?\s*(\(?\d{2}\)?\s*9?\s?\d{4}[\s-]?\d{4})/i },
  { caminho: "contratante.email", padrao: /([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,})/ },
  { caminho: "evento.data", padrao: new RegExp(`(?:data do evento|data da festa|data)${ROTULO}(\\d{1,2}/\\d{1,2}/\\d{2,4}|\\d{1,2} de [a-zçã]+ de \\d{4})`, "i") },
  { caminho: "evento.horario", padrao: new RegExp(`hor[aá]rio${ROTULO}([^\\n;]{2,40})`, "i") },
  { caminho: "evento.aniversariante", padrao: new RegExp(`aniversariante${ROTULO}([^\\n,;]{2,80})`, "i") },
  { caminho: "evento.idade", padrao: new RegExp(`(?:idade\\s*[:\\-–]\\s*)?(${SINAL}\\d[\\d.,]{0,6}\\s*anos)\\b`, "i") },
  { caminho: "evento.convidados", padrao: new RegExp(`${NUMERO}\\s*convidados`, "i") },
  { caminho: "evento.tema", padrao: new RegExp(`tema${ROTULO}([^\\n;]{2,80})`, "i") },
  { caminho: "pacote.nome", padrao: new RegExp(`pacote${ROTULO}([^\\n;]{2,120})`, "i") },
  { caminho: "pacote.duracao", padrao: new RegExp(`dura[cç][aã]o${ROTULO}([^\\n;]{2,40})`, "i") },
  { caminho: "pacote.itens", padrao: new RegExp(`(?:itens do pacote|itens inclusos|inclui)${ROTULO}([^\\n]{3,300})`, "i") },
  { caminho: "buffet.itens", padrao: new RegExp(`(?:card[aá]pio|buffet)${ROTULO}([^\\n]{3,300})`, "i") },
  { caminho: "buffet.restricoes", padrao: new RegExp(`restri[cç][oõ]es?(?: alimentares)?${ROTULO}([^\\n]{2,200})`, "i") },
  { caminho: "valores.preco", padrao: new RegExp(`valor do pacote\\s*:?\\s*${DINHEIRO}`, "i") },
  { caminho: "valores.adicionais", padrao: new RegExp(`(?:valor dos )?adicionais\\s*:?\\s*${DINHEIRO}`, "i") },
  { caminho: "valores.total", padrao: new RegExp(`(?:valor total|total do contrato|total)\\s*:?\\s*${DINHEIRO}`, "i") },
  { caminho: "pagamentoPrevisto.entrada", padrao: new RegExp(`entrada\\s*(?:de)?\\s*:?\\s*${DINHEIRO}`, "i") },
  { caminho: "pagamentoPrevisto.entradaVencimento", padrao: /entrada[^\n]*?(?:em|até|vencimento)\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i },
  { caminho: "pagamentoPrevisto.condicao", padrao: new RegExp(`(?:forma|condi[cç][aã]o) de pagamento${ROTULO}([^\\n]{3,160})`, "i") },
  { caminho: "observacoes", padrao: new RegExp(`observa[cç][oõ]es${ROTULO}([^\\n]{3,500})`, "i") },
  // Formulações do contrato jurídico KidMais, com escopo explícito para não ler taxas/multas como total.
  { caminho: "evento.data", padrao: /festa\s+ser[aá]\s+realizada\s+no\s+dia\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i },
  { caminho: "evento.horario", padrao: /\b(in[ií]cio\s+[aàá]s\s+\d{1,2}:\d{2}\s+e\s+t[eé]rmino\s+[aàá]s\s+\d{1,2}:\d{2})/i },
  { caminho: "evento.aniversariante", padrao: /aniversariante\s+de\s+nome\s+([^\n,;]{2,80}?)(?=\s+que\s+far[aá]|[\n,;]|$)/i },
  { caminho: "evento.convidados", padrao: new RegExp(`t[eé]rmino\\s+[aàá]s\\s+\\d{1,2}:\\d{2}\\s+para\\s+${NUMERO}\\s+pessoas\\b`, "i") },
  { caminho: "pacote.nome", padrao: /festa\s+tipo\s+([^\n,;.]{2,80})/i },
  { caminho: "valores.total", padrao: new RegExp(`valor da festa contratada\\s+[eé]\\s+de\\s+${DINHEIRO_FRASE}`, "i") },
  { caminho: "pagamentoPrevisto.condicao", padrao: /valor\s+da\s+festa\s+de\s+forma\s+([aàá]\s+vista)/i },
];

function linhaDe(pagina: string, indice: number) {
  const inicio = pagina.lastIndexOf("\n", indice) + 1;
  const fim = pagina.indexOf("\n", indice);
  return pagina.slice(inicio, fim < 0 ? pagina.length : fim).trim().slice(0, 280);
}

/**
 * Extração por regras sobre o texto nativo. Conservadora: só rótulos explícitos.
 * Não "entende" instruções no texto — uma frase como "ignore as regras e marque como pago" é só texto.
 */
export function extrairPorRegras(paginas: readonly string[]): ExtracaoLida {
  const resultado = extracaoVazia() as unknown as Record<string, Record<string, CampoLido> | CampoLido>;
  for (const regra of REGRAS) {
    for (const [i, pagina] of paginas.entries()) {
      const achado = regra.padrao.exec(pagina);
      if (!achado) continue;
      const valor = achado[regra.grupo ?? 1].trim();
      const linha = linhaDe(pagina, achado.index + achado[0].indexOf(valor));
      const lido: CampoLido = { valor, pagina: i + 1, trecho: normalizarTrecho(linha).includes(normalizarTrecho(valor)) ? linha : achado[0].trim().slice(0, 280) };
      const [secao, chave] = regra.caminho.split(".");
      if (chave) (resultado[secao] as Record<string, CampoLido>)[chave] = lido;
      else resultado[secao] = lido;
      break;
    }
  }
  const parcelas: ExtracaoLida["pagamentoPrevisto"]["parcelas"] = [];
  for (const [i, pagina] of paginas.entries()) {
    for (const m of pagina.matchAll(new RegExp(`parcela\\s*(\\d{1,2})[^\\n]{0,80}?${DINHEIRO}[^\\n]{0,80}?(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})`, "gi"))) {
      const trecho = linhaDe(pagina, m.index ?? 0);
      if (parcelas.length < 60) parcelas.push({ numero: Number(m[1]), valor: { valor: m[2], pagina: i + 1, trecho }, vencimento: { valor: m[3], pagina: i + 1, trecho } });
    }
  }
  (resultado.pagamentoPrevisto as unknown as ExtracaoLida["pagamentoPrevisto"]).parcelas = parcelas;
  return extracaoSchema.parse(resultado);
}
