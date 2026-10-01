import { centavosComerciais } from "./condicao-pagamento.ts";

/** Três modelos comerciais. A tela atual edita só por faixa, que é o cálculo já gravado. */
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

export function normalizarValorInformado(texto: string) {
  const limpo = texto.trim().replace(/\s/g, "").replace(/^R\$/i, "");
  if (limpo.includes(",") && limpo.includes(".")) return limpo.replace(/\./g, "").replace(",", ".");
  if (limpo.includes(",")) return limpo.replace(",", ".");
  return limpo;
}
