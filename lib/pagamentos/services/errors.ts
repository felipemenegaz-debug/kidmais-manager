export type PagamentoServiceErrorCode =
  | "SUGESTAO_PIX_INVALIDA"
  | "SUGESTAO_PIX_DESATUALIZADA"
  | "SUGESTAO_PIX_NAO_PERMITIDA"
  | "CRONOGRAMA_CONSOLIDADO"
  | "PAGAMENTO_NAO_ENCONTRADO"
  | "PAGAMENTO_JA_EXISTE"
  | "PAGAMENTO_CANCELADO"
  | "FECHAMENTO_NAO_ENCONTRADO"
  | "STATUS_FECHAMENTO_NAO_PERMITE_PAGAMENTO"
  | "CONTRATO_NAO_ENCONTRADO"
  | "CONTRATO_NAO_ASSINADO"
  | "VERSAO_CONTRATUAL_NAO_ASSINADA"
  | "VALOR_CONTRATUAL_INVALIDO"
  | "PLANO_PAGAMENTO_INVALIDO"
  | "PLANO_NAO_ENCONTRADO"
  | "PLANO_NAO_PODE_SER_SUBSTITUIDO"
  | "PARCELA_NAO_ENCONTRADA"
  | "RECEBIMENTO_NAO_ENCONTRADO"
  | "RECEBIMENTO_INVALIDO"
  | "RECEBIMENTO_NAO_PODE_SER_CONFIRMADO"
  | "ALOCACAO_INVALIDA"
  | "VALOR_EXCEDE_SALDO"
  | "ESTORNO_INVALIDO"
  | "COMPROVANTE_INVALIDO";

export class PagamentoServiceError extends Error {
  public readonly code: PagamentoServiceErrorCode;
  public readonly httpStatus: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: PagamentoServiceErrorCode,
    message: string,
    httpStatus = 400,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PagamentoServiceError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export function isPagamentoServiceError(error: unknown): error is PagamentoServiceError {
  return error instanceof PagamentoServiceError;
}
