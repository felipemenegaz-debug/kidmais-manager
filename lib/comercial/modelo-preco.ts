import { centavosComerciais } from "./condicao-pagamento.ts";

/** Três modelos comerciais. A tela edita por quantidades cheias (PontoPreco, 092); as faixas fixas são o modelo anterior. */
export type FaixaFixa = {
  convidadosMin: number;
  convidadosMax: number | null;
  valor: string;
};

export type ModeloPreco =
  | { tipo: "POR_FAIXA"; faixas: FaixaFixa[] }
  | { tipo: "BASE_EXCEDENTE"; ate: number; valorBase: string; valorAdicional: string }
  | { tipo: "POR_CONVIDADO"; valor: string; minimoFaturavel: number };

export class ModeloPrecoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModeloPrecoError";
  }
}

function valorFixo(valor: string) {
  let centavos: number;
  try {
    centavos = centavosComerciais(valor);
  } catch {
    throw new ModeloPrecoError("Informe o preço com até duas casas decimais.");
  }
  if (centavos <= 0) throw new ModeloPrecoError("Informe um preço maior que zero.");
  return (centavos / 100).toFixed(2);
}

export function validarFaixas(
  faixas: FaixaFixa[],
  limites: { minimo: number; maximo: number },
): FaixaFixa[] {
  if (!Number.isInteger(limites.minimo) || !Number.isInteger(limites.maximo) || limites.minimo < 1 || limites.maximo < limites.minimo) {
    throw new ModeloPrecoError("Informe o mínimo e o máximo de convidados.");
  }
  if (faixas.length === 0) return [];
  const ordenadas = [...faixas].sort((a, b) => a.convidadosMin - b.convidadosMin || (a.convidadosMax ?? 100000) - (b.convidadosMax ?? 100000));
  const prontas: FaixaFixa[] = [];
  for (const faixa of ordenadas) {
    if (!Number.isInteger(faixa.convidadosMin) || faixa.convidadosMin < 1) {
      throw new ModeloPrecoError("Cada faixa precisa começar em pelo menos 1 convidado.");
    }
    if (faixa.convidadosMax != null && (!Number.isInteger(faixa.convidadosMax) || faixa.convidadosMax < faixa.convidadosMin)) {
      throw new ModeloPrecoError("O fim da faixa não pode ser menor que o começo.");
    }
    if (faixa.convidadosMin < limites.minimo || (faixa.convidadosMax != null && faixa.convidadosMax > limites.maximo) || (faixa.convidadosMax == null && faixa.convidadosMin > limites.maximo)) {
      throw new ModeloPrecoError("As faixas de preço precisam caber entre o mínimo e o máximo de convidados do pacote.");
    }
    if (faixa.convidadosMax == null && limites.maximo != null) {
      throw new ModeloPrecoError("Informe até quantos convidados vale cada preço.");
    }
    const valor = valorFixo(normalizarValorInformado(faixa.valor));
    const anterior = prontas[prontas.length - 1];
    if (anterior && (anterior.convidadosMax == null || faixa.convidadosMin <= anterior.convidadosMax)) {
      throw new ModeloPrecoError("As faixas de convidados não podem se sobrepor.");
    }
    prontas.push({ convidadosMin: faixa.convidadosMin, convidadosMax: faixa.convidadosMax, valor });
  }
  return prontas;
}

export function faixasContiguas(faixas: FaixaFixa[], limites: { minimo: number; maximo: number }) {
  if (faixas.length === 0) return false;
  if (faixas[0]?.convidadosMin !== limites.minimo) return false;
  if (faixas[faixas.length - 1]?.convidadosMax !== limites.maximo) return false;
  for (let i = 1; i < faixas.length; i += 1) {
    const anterior = faixas[i - 1];
    const atual = faixas[i];
    if (!anterior || !atual || anterior.convidadosMax == null || atual.convidadosMin !== anterior.convidadosMax + 1) return false;
  }
  return true;
}

/**
 * Preço por quantidades cheias (092, decisão de Felipe em 22/10/2026): o buffet informa o preço de 50, 60, 70...
 * Entre dois pontos, cada convidado custa a diferença até o próximo dividida pelos convidados entre os dois.
 */
export type PontoPreco = {
  convidados: number;
  valor: string;
};

export const MAXIMO_PONTOS = 40;

function reais(centavos: number) {
  return `R$ ${(centavos / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function validarPontos(
  pontos: PontoPreco[],
  limites: { minimo: number; maximo: number },
): PontoPreco[] {
  if (!Number.isInteger(limites.minimo) || !Number.isInteger(limites.maximo) || limites.minimo < 1 || limites.maximo < limites.minimo) {
    throw new ModeloPrecoError("Informe o mínimo e o máximo de convidados.");
  }
  if (pontos.length === 0) return [];
  if (pontos.length > MAXIMO_PONTOS) throw new ModeloPrecoError(`Informe no máximo ${MAXIMO_PONTOS} quantidades.`);
  const ordenados = [...pontos].sort((a, b) => a.convidados - b.convidados);
  const prontos: PontoPreco[] = [];
  let centavosAnterior = 0;
  for (const ponto of ordenados) {
    if (!Number.isInteger(ponto.convidados) || ponto.convidados < limites.minimo || ponto.convidados > limites.maximo) {
      throw new ModeloPrecoError("As quantidades precisam ficar entre o mínimo e o máximo de convidados do pacote.");
    }
    const anterior = prontos[prontos.length - 1];
    if (anterior && anterior.convidados === ponto.convidados) {
      throw new ModeloPrecoError(`A quantidade ${ponto.convidados} aparece mais de uma vez.`);
    }
    const valor = valorFixo(normalizarValorInformado(ponto.valor));
    const centavos = Math.round(Number(valor) * 100);
    if (anterior && centavos < centavosAnterior) {
      throw new ModeloPrecoError(
        `O preço de ${ponto.convidados} convidados precisa ser igual ou maior que o de ${anterior.convidados} convidados (${reais(centavosAnterior)}).`,
      );
    }
    centavosAnterior = centavos;
    prontos.push({ convidados: ponto.convidados, valor });
  }
  if (prontos[0]?.convidados !== limites.minimo || prontos[prontos.length - 1]?.convidados !== limites.maximo) {
    throw new ModeloPrecoError(`A primeira quantidade precisa ser ${limites.minimo} e a última ${limites.maximo}, o mínimo e o máximo do pacote.`);
  }
  return prontos;
}

/**
 * Valor para `convidados` pelos pontos (em centavos), arredondado só no fim, meio centavo para cima.
 * Fora do primeiro e do último ponto não há preço (null).
 */
export function centavosPorPontos(pontos: PontoPreco[], convidados: number) {
  const ordenados = [...pontos].sort((a, b) => a.convidados - b.convidados);
  for (let i = 0; i < ordenados.length; i += 1) {
    const inferior = ordenados[i];
    if (!inferior) continue;
    const centavosInferior = Math.round(Number(inferior.valor) * 100);
    if (inferior.convidados === convidados) return { centavos: centavosInferior, inferior, superior: inferior };
    const superior = ordenados[i + 1];
    if (superior && convidados > inferior.convidados && convidados < superior.convidados) {
      const diferenca = Math.round(Number(superior.valor) * 100) - centavosInferior;
      const passos = superior.convidados - inferior.convidados;
      const numerador = (convidados - inferior.convidados) * diferenca;
      const acrescimo = numerador >= 0
        ? Math.floor((2 * numerador + passos) / (2 * passos))
        : -Math.floor((-2 * numerador + passos) / (2 * passos));
      return { centavos: centavosInferior + acrescimo, inferior, superior };
    }
  }
  return null;
}

/**
 * Proposta de conversão das faixas antigas (preço fixo dentro da faixa): o começo de cada faixa vira um ponto com o
 * preço dela, e o máximo do pacote recebe o preço da faixa que o contém. Não valida: a tela mostra e o buffet confirma.
 */
export function pontosDeFaixas(faixas: FaixaFixa[], limites: { minimo: number; maximo: number }): PontoPreco[] {
  const ordenadas = [...faixas].sort((a, b) => a.convidadosMin - b.convidadosMin);
  const pontos: PontoPreco[] = [];
  for (const faixa of ordenadas) {
    if (faixa.convidadosMin > limites.maximo) continue;
    pontos.push({ convidados: Math.max(faixa.convidadosMin, limites.minimo), valor: Number(faixa.valor).toFixed(2) });
  }
  const ultimo = pontos[pontos.length - 1];
  if (ultimo && ultimo.convidados < limites.maximo) {
    const contem = ordenadas.find((f) => f.convidadosMin <= limites.maximo && (f.convidadosMax == null || f.convidadosMax >= limites.maximo));
    pontos.push({ convidados: limites.maximo, valor: Number((contem ?? ordenadas[ordenadas.length - 1])?.valor ?? ultimo.valor).toFixed(2) });
  }
  const unicos = new Map<number, PontoPreco>();
  for (const ponto of pontos) unicos.set(ponto.convidados, ponto);
  return [...unicos.values()];
}

export function normalizarValorInformado(texto: string) {
  const limpo = texto.trim().replace(/\s/g, "").replace(/^R\$/i, "");
  if (limpo.includes(",") && limpo.includes(".")) return limpo.replace(/\./g, "").replace(",", ".");
  if (limpo.includes(",")) return limpo.replace(",", ".");
  return limpo;
}
