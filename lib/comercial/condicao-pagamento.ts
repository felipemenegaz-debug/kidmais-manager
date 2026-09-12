/** Regras comerciais compartilhadas pela interface e pelo backend. */
export type FormaComercial = "PIX_AVISTA" | "PIX_PARCELADO" | "CARTAO_CIELO";
export type PretensaoPixInput = {
  entrada?: number | string | null;
  valorParcela?: number | string | null;
  quantidadeParcelas?: number | null;
};
export type CondicaoPix = {
  entradaCentavos: number | null;
  parcelaCentavos: number | null;
  quantidadeParcelas: number | null;
};
export type ValoresPagamento = {
  valorBaseComercial: number;
  descontoFormaPagamentoPercentual: number;
  valorDescontoFormaPagamento: number;
  valorFinalContrato: number;
};
export type CondicaoPagamento = {
  schemaVersao: 1;
  forma: FormaComercial;
  pretendida: CondicaoPix | null;
  aprovada: CondicaoPix | null;
  revisaoStatus: "PENDENTE" | "APROVADA" | "DISPENSADA" | "RECUSADA";
};
export type DecisaoCondicaoPagamento = CondicaoPagamento & {
  solicitacaoId?: string;
  decisaoHash?: string;
  valores?: ValoresPagamento;
};

export class CondicaoPagamentoError extends Error {}

export function centavosComerciais(valor: unknown, permiteZero = false): number {
  if (typeof valor === "string") {
    if (!/^\d+(?:\.\d{1,2})?$/.test(valor)) {
      throw new CondicaoPagamentoError("Informe valores monetários com no máximo duas casas decimais.");
    }
    valor = Number(valor);
  }
  if (typeof valor !== "number" || !Number.isFinite(valor)) {
    throw new CondicaoPagamentoError("Valor monetário inválido.");
  }
  const centavos = Math.round(valor * 100);
  if (!Number.isSafeInteger(centavos) || centavos > 999999999999 ||
    centavos < (permiteZero ? 0 : 1) || valor !== centavos / 100) {
    throw new CondicaoPagamentoError("O valor deve respeitar a precisão de centavos e o limite monetário.");
  }
  return centavos;
}

export function validarPretensaoPix(input?: PretensaoPixInput | null): CondicaoPix | null {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).some((key) => !["entrada", "valorParcela", "quantidadeParcelas"].includes(key))) {
    throw new CondicaoPagamentoError("Condição pretendida inválida.");
  }
  const quantidade = input.quantidadeParcelas ?? null;
  if (quantidade !== null && (!Number.isSafeInteger(quantidade) || quantidade < 1)) {
    throw new CondicaoPagamentoError("A quantidade de parcelas deve ser um inteiro positivo.");
  }
  const entrada = input.entrada == null ? null : centavosComerciais(input.entrada, true);
  const parcela = input.valorParcela == null ? null : centavosComerciais(input.valorParcela);
  if (entrada === null && parcela === null && quantidade === null) return null;
  return { entradaCentavos: entrada, parcelaCentavos: parcela, quantidadeParcelas: quantidade };
}

export function calcularCondicaoComercial(base: number, forma: FormaComercial): ValoresPagamento {
  const centavos = centavosComerciais(base);
  if (!["PIX_AVISTA", "PIX_PARCELADO", "CARTAO_CIELO"].includes(forma)) {
    throw new CondicaoPagamentoError("Forma de pagamento inválida.");
  }
  const percentual = forma === "PIX_AVISTA" ? 10 : forma === "PIX_PARCELADO" ? 3 : 0;
  // O produto inteiro permanece abaixo de Number.MAX_SAFE_INTEGER no domínio numeric(12,2).
  const final = Math.floor((centavos * (100 - percentual) + 50) / 100);
  return {
    valorBaseComercial: centavos / 100,
    descontoFormaPagamentoPercentual: percentual,
    valorDescontoFormaPagamento: (centavos - final) / 100,
    valorFinalContrato: final / 100,
  };
}
