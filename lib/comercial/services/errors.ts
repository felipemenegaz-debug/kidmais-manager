export type PricingServiceErrorCode =
  | "DADOS_INVALIDOS"
  | "PACOTE_NAO_ENCONTRADO"
  | "TABELA_PRECO_NAO_CONFIGURADA"
  | "CATEGORIA_HORARIO_NAO_CONFIGURADA"
  | "ELEGIBILIDADE_NAO_CONFIGURADA"
  | "PACOTE_INDISPONIVEL"
  | "PACOTE_SOB_CONSULTA"
  | "PRECO_PACOTE_NAO_CONFIGURADO"
  | "ADICIONAL_DUPLICADO"
  | "ADICIONAL_NAO_ENCONTRADO"
  | "PRECO_ADICIONAL_NAO_CONFIGURADO";

export class PricingServiceError extends Error {
  constructor(
    public readonly code: PricingServiceErrorCode,
    message: string,
    public readonly httpStatus = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PricingServiceError";
  }
}

export function isPricingServiceError(
  error: unknown,
): error is PricingServiceError {
  return error instanceof PricingServiceError;
}
