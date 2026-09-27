export type PricingServiceErrorCode =
  | "DADOS_INVALIDOS"
  | "PACOTE_NAO_ENCONTRADO"
  | "TABELA_PRECO_NAO_CONFIGURADA"
  | "CATEGORIA_HORARIO_NAO_CONFIGURADA"
  | "ELEGIBILIDADE_NAO_CONFIGURADA"
  | "PACOTE_INDISPONIVEL"
  | "PACOTE_SOB_CONSULTA"
  | "PRECO_PACOTE_NAO_CONFIGURADO"
  | "PRECO_AMBIGUO"
  | "ADICIONAL_DUPLICADO"
  | "ADICIONAL_NAO_ENCONTRADO"
  | "PRECO_ADICIONAL_NAO_CONFIGURADO";

export class PricingServiceError extends Error {
  readonly code: PricingServiceErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: PricingServiceErrorCode,
    message: string,
    httpStatus = 400,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PricingServiceError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export function isPricingServiceError(
  error: unknown,
): error is PricingServiceError {
  return error instanceof PricingServiceError;
}
