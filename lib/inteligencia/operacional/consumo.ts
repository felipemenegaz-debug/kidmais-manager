import { normalizar } from "../texto-pt.ts";

/**
 * Quantidades operacionais (IA operacional, marco B): detecção da pergunta, leitura dos parâmetros escritos pelo
 * operador e cálculo DETERMINÍSTICO. Nenhum número nasce aqui sem estar no texto, na regra da empresa ou no Core.
 *
 * - Inteiros em unidades mínimas (unidade de doce, mililitro): sem ponto flutuante.
 * - Só embalagem indivisível é arredondada (para cima), sempre com a sobra mostrada.
 * - Margem, distribuição e embalagem só entram se informadas (regra da empresa ou texto do pedido).
 * - Distribuição nunca é presumida: percentuais fecham 100%; quantidades fecham o total — senão, esclarecimento.
 */
export const CATEGORIAS_CONSUMO = ["DOCES", "REFRIGERANTES"] as const;
export type CategoriaConsumo = (typeof CATEGORIAS_CONSUMO)[number];

const PALAVRAS: Readonly<Record<CategoriaConsumo, RegExp>> = {
  DOCES: /\b(doces?|docinhos?|brigadeiros?)\b/,
  REFRIGERANTES: /\b(refrigerantes?|refris?)\b/,
};

/**
 * A quantidade pedida é DA categoria ("quantos docinhos", "quantos litros de refrigerante", "quantidade de doces",
 * "calcule os refrigerantes"): "quantos convidados … e quais doces" pergunta convidados e escolhas, não um cálculo.
 */
const PEDE_QUANTIDADE = /\b(?:quant[oa]s?|quantidade(?: de)?|calcul\w*(?: (?:a|o|os|as))?(?: quantidade de)?)\s+(?:\w+\s+)?(?:de\s+)?(?:doces?|docinhos?|brigadeiros?|refrigerantes?|refris?)\b/;
const VERBO_MUTACAO = /\b(crie|criar|cadastr(e|ar)|salv(e|ar|a)|grav(e|ar)|registr(e|ar)|alter(e|ar)|mud(e|ar)|exclu\w*|apag\w*|envi(e|ar))\b/;

/** Categorias citadas no texto (normalizado ou não). */
export function categoriasCitadas(texto: string): CategoriaConsumo[] {
  const n = normalizar(texto);
  return CATEGORIAS_CONSUMO.filter((c) => PALAVRAS[c].test(n));
}

/**
 * Pergunta de quantidade operacional ("quantos docinhos devo fazer…?", "quantos refrigerantes a festa vai precisar?").
 * Vocabulário FECHADO de categorias; pedido com verbo de mutação (salvar/criar/alterar) nunca é consulta.
 */
export function detectarConsumo(texto: string): { categorias: CategoriaConsumo[] } | null {
  const n = normalizar(texto);
  // "4 docinhos por convidado para a próxima festa" também pede o cálculo (parâmetro escrito, sem "quantos").
  if (VERBO_MUTACAO.test(n) || !(PEDE_QUANTIDADE.test(n) || /\bpor (convidad|pessoa|crianc)/.test(n))) return null;
  const categorias = categoriasCitadas(n);
  return categorias.length ? { categorias } : null;
}

/** Pedido para gravar um parâmetro como PADRÃO da empresa (proposta separada, sob Human Gate). */
export function pedeSalvarParametro(texto: string): boolean {
  const n = normalizar(texto);
  return /\b(salv\w*|grav\w*|guard\w*|defin\w*|us\w* sempre|cadastr\w*)\b/.test(n) && /\b(padrao|sempre|regra)\b/.test(n) && categoriasCitadas(n).length === 1;
}

// ---------------------------------------------------------------- parâmetros escritos

export type DistribuicaoInformada = { tipo: string; percentual?: number; quantidade?: number };

export type ParametrosConsumo = {
  porConvidado?: number;
  mlPorConvidado?: number;
  embalagemMl?: number;
  margemPercentual?: number;
  distribuicao?: DistribuicaoInformada[];
};

/** "2", "2,5", "2.000" (milhar), "0,35" ⇒ milésimos inteiros (ex.: litros → mL). Sem ponto flutuante. */
function milesimos(bruto: string): number | undefined {
  const t = bruto.trim();
  // Milhar com ponto ("2.000") só quando há exatamente 3 dígitos depois de cada ponto.
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) return Number(t.replace(/\./g, "")) * 1000;
  const m = /^(\d{1,6})(?:[.,](\d{1,3}))?$/.exec(t);
  if (!m) return undefined;
  return Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0"));
}

/** Volume em mL a partir de número + unidade ("400 ml", "0,4 l", "2 litros", "2l"). */
function volumeMl(numero: string, unidade: string): number | undefined {
  const mil = milesimos(numero);
  if (mil === undefined) return undefined;
  if (/^ml$/.test(unidade)) return mil % 1000 === 0 ? mil / 1000 : undefined;
  return mil; // litros ⇒ mililitros
}

const NUM = String.raw`(\d{1,6}(?:[.,]\d{1,3})*)`;
const POR_PESSOA = String.raw`\s*(?:por|\/|a cada)\s*(?:convidad\w*|pessoas?|crianc\w*|cabeca)`;
const UNIDADE_VOL = String.raw`\s*(ml|l|lts?|litros?)\b`;

/**
 * Parâmetros que o operador ESCREVEU para este cálculo. `continuacao` = resposta direta à pergunta de parâmetro
 * (aceita só o número: "4", "400 ml"). Nada é inferido do nome do pacote ou de outra categoria.
 */
export type ParametroPerguntado = "POR_CONVIDADO" | "ML_POR_CONVIDADO" | "EMBALAGEM";

export function extrairParametros(texto: string, categoria: CategoriaConsumo, perguntado: ParametroPerguntado | null = null): ParametrosConsumo {
  const continuacao = perguntado === "POR_CONVIDADO";
  const n = normalizar(texto).replace(/(\d)\s*(?=l\b|ml\b|lts?\b|litros?\b)/g, "$1 ");
  const p: ParametrosConsumo = {};
  const margem = new RegExp(String.raw`\bmargem\s*(?:de\s*)?(\d{1,3})\s*%|(\d{1,3})\s*%\s*(?:de\s*)?(?:margem|sobra|a mais|extra)`).exec(n);
  if (margem) {
    const v = Number(margem[1] ?? margem[2]);
    if (v >= 0 && v <= 100) p.margemPercentual = v;
  }
  if (categoria === "DOCES") {
    const por = new RegExp(String.raw`(\d{1,3})\s*(?:doces?|docinhos?|unidades?|brigadeiros?)?${POR_PESSOA}`).exec(n);
    if (por) p.porConvidado = Number(por[1]);
    else if (continuacao) {
      const so = /^(?:sao |usamos |uso |a empresa (?:usa|utiliza) )?(\d{1,3})(?:\s*(?:doces?|docinhos?|unidades?))?\.?$/.exec(n);
      if (so) p.porConvidado = Number(so[1]);
    }
    if (p.porConvidado !== undefined && (p.porConvidado < 1 || p.porConvidado > 100)) delete p.porConvidado;
    const distribuicao = extrairDistribuicao(n);
    if (distribuicao) p.distribuicao = distribuicao;
    return p;
  }
  // REFRIGERANTES: taxa por convidado (com unidade) e embalagem (garrafa/lata/pet/embalagem ou "cada").
  const taxa = new RegExp(`${NUM}${UNIDADE_VOL}(?:\\s*de\\s*(?:refrigerantes?|refris?|bebidas?))?${POR_PESSOA}`).exec(n);
  if (taxa) {
    const ml = volumeMl(taxa[1], taxa[2]);
    if (ml && ml >= 1 && ml <= 5000) p.mlPorConvidado = ml;
  }
  const emb = new RegExp(String.raw`\b(?:garrafas?|embalage\w*|pets?|latas?|latinhas?|frascos?)\s*(?:de\s*)?${NUM}${UNIDADE_VOL}|${NUM}${UNIDADE_VOL}\s*(?:cada|por garrafa|por embalagem|por lata)`).exec(n);
  if (emb) {
    const ml = emb[1] !== undefined ? volumeMl(emb[1], emb[2]) : volumeMl(emb[3], emb[4]);
    if (ml && ml >= 50 && ml <= 20000) p.embalagemMl = ml;
  }
  // Resposta curta à pergunta feita ("400 ml", "2 litros"): um único volume vale para o parâmetro PERGUNTADO.
  const volumes = [...n.matchAll(new RegExp(`${NUM}${UNIDADE_VOL}`, "g"))];
  if (perguntado && volumes.length === 1 && p.mlPorConvidado === undefined && p.embalagemMl === undefined) {
    const ml = volumeMl(volumes[0][1], volumes[0][2]);
    if (ml && perguntado === "ML_POR_CONVIDADO" && ml <= 5000) p.mlPorConvidado = ml;
    if (ml && perguntado === "EMBALAGEM" && ml >= 50 && ml <= 20000) p.embalagemMl = ml;
  }
  return p;
}

/** "50% brigadeiro, 30% beijinho e 20% cajuzinho" ou "100 brigadeiros e 100 beijinhos". Nada além disso. */
function extrairDistribuicao(n: string): DistribuicaoInformada[] | undefined {
  const percentuais = [...n.matchAll(/(\d{1,3})\s*%\s*(?:de\s*)?([a-z][a-z ]{1,38}?)(?=\s*(?:,|;|\be\b|$))/g)]
    .filter((m) => !/\b(margem|sobra|a mais|extra)\b/.test(m[2]));
  if (percentuais.length >= 2) return percentuais.map((m) => ({ tipo: m[2].trim(), percentual: Number(m[1]) }));
  const quantidades = [...n.matchAll(/(\d{1,5})\s+(?!por\b|doces?\b|docinhos?\b|convidad|pessoa|crianc|unidades?\b)([a-z][a-z]{2,38})(?=\s*(?:,|;|\be\b|$))/g)];
  if (quantidades.length >= 2) return quantidades.map((m) => ({ tipo: m[2].trim(), quantidade: Number(m[1]) }));
  return undefined;
}

// ---------------------------------------------------------------- cálculo

export const formatar = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/** mL ⇒ "20 L" / "20,5 L" / "750 mL" (exato, sem ponto flutuante). */
export function litros(ml: number): string {
  if (ml < 1000) return `${formatar(ml)} mL`;
  const inteiro = Math.floor(ml / 1000);
  const resto = String(ml % 1000).padStart(3, "0").replace(/0+$/, "");
  return `${formatar(inteiro)}${resto ? `,${resto}` : ""} L`;
}

/** Arredonda para cima sem ponto flutuante: ceil(a / b), a e b inteiros positivos. */
const teto = (a: number, b: number) => Math.floor((a + b - 1) / b);

export type ItemDistribuido = { tipo: string; quantidade: number };

export type ResultadoDoces =
  | { tipo: "CALCULADO"; base: number; margem: number; total: number; formula: string[]; distribuicao: ItemDistribuido[] | null }
  | { tipo: "DISTRIBUICAO_INVALIDA"; base: number; margem: number; total: number; formula: string[]; motivo: string };

export function calcularDoces(convidados: number, porConvidado: number, margemPercentual?: number, distribuicao?: readonly DistribuicaoInformada[]): ResultadoDoces {
  const base = convidados * porConvidado;
  const margem = margemPercentual ? teto(base * margemPercentual, 100) : 0;
  const total = base + margem;
  const formula = [`${formatar(convidados)} convidados × ${porConvidado} = ${formatar(base)} docinhos.`];
  if (margem) formula.push(`Margem de ${margemPercentual}%: + ${formatar(margem)} (arredondado para cima, doce é unidade inteira) = ${formatar(total)} docinhos.`);
  if (!distribuicao?.length) return { tipo: "CALCULADO", base, margem, total, formula, distribuicao: null };

  if (distribuicao.every((d) => d.percentual !== undefined)) {
    const soma = distribuicao.reduce((s, d) => s + d.percentual!, 0);
    if (soma !== 100) return { tipo: "DISTRIBUICAO_INVALIDA", base, margem, total, formula, motivo: `Os percentuais somam ${soma}%, não 100%.` };
    // Maior resto: cada tipo recebe a parte inteira; as unidades que sobram vão aos maiores restos (total conservado).
    const partes = distribuicao.map((d, i) => ({ i, tipo: d.tipo, inteiro: Math.floor((total * d.percentual!) / 100), resto: (total * d.percentual!) % 100 }));
    let faltam = total - partes.reduce((s, p) => s + p.inteiro, 0);
    for (const p of [...partes].sort((a, b) => b.resto - a.resto || a.i - b.i)) {
      if (faltam <= 0) break;
      p.inteiro += 1;
      faltam -= 1;
    }
    const itens = partes.map((p) => ({ tipo: p.tipo, quantidade: p.inteiro }));
    formula.push(`Divisão informada (${distribuicao.map((d) => `${d.percentual}% ${d.tipo}`).join(", ")}): ${itens.map((x) => `${formatar(x.quantidade)} ${x.tipo}`).join(", ")}; total conservado em ${formatar(total)}.`);
    return { tipo: "CALCULADO", base, margem, total, formula, distribuicao: itens };
  }
  if (distribuicao.every((d) => d.quantidade !== undefined)) {
    const soma = distribuicao.reduce((s, d) => s + d.quantidade!, 0);
    if (soma !== total) return { tipo: "DISTRIBUICAO_INVALIDA", base, margem, total, formula, motivo: `As quantidades informadas somam ${formatar(soma)}, mas o total calculado é ${formatar(total)}.` };
    return { tipo: "CALCULADO", base, margem, total, formula, distribuicao: distribuicao.map((d) => ({ tipo: d.tipo, quantidade: d.quantidade! })) };
  }
  return { tipo: "DISTRIBUICAO_INVALIDA", base, margem, total, formula, motivo: "Misture só percentuais ou só quantidades na divisão." };
}

export type ResultadoRefrigerantes = {
  totalMl: number;
  margemMl: number;
  embalagens: number | null;
  sobraMl: number | null;
  formula: string[];
};

export function calcularRefrigerantes(convidados: number, mlPorConvidado: number, embalagemMl?: number, margemPercentual?: number): ResultadoRefrigerantes {
  const base = convidados * mlPorConvidado;
  const margemMl = margemPercentual ? teto(base * margemPercentual, 100) : 0;
  const totalMl = base + margemMl;
  const formula = [`${formatar(convidados)} convidados × ${formatar(mlPorConvidado)} mL = ${formatar(base)} mL = ${litros(base)}.`];
  if (margemMl) formula.push(`Margem de ${margemPercentual}%: + ${formatar(margemMl)} mL = ${formatar(totalMl)} mL = ${litros(totalMl)}.`);
  if (!embalagemMl) return { totalMl, margemMl, embalagens: null, sobraMl: null, formula };
  const embalagens = teto(totalMl, embalagemMl);
  const sobraMl = embalagens * embalagemMl - totalMl;
  formula.push(`${formatar(totalMl)} mL ÷ ${litros(embalagemMl)} por embalagem = ${embalagens} ${embalagens === 1 ? "embalagem" : "embalagens"} (embalagem indivisível, arredondado para cima; sobra de ${litros(sobraMl)}).`);
  return { totalMl, margemMl, embalagens, sobraMl, formula };
}
