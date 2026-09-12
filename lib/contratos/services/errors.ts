export type ContratoServiceErrorCode =
  | "FECHAMENTO_NAO_ENCONTRADO"
  | "STATUS_FECHAMENTO_NAO_PERMITE_CONTRATO"
  | "CLIENTE_NAO_VINCULADO"
  | "CADASTRO_CONTRATUAL_INCOMPLETO"
  | "ANIVERSARIANTE_NAO_VINCULADO"
  | "REFERENCIA_COMERCIAL_INCONSISTENTE"
  | "CONTRATO_NAO_ENCONTRADO"
  | "CONTRATO_ACESSO_NAO_AUTORIZADO"
  | "CONTRATO_ASSINADO_NAO_REGERAR"
  | "CONTRATO_CANCELADO_NAO_REGERAR"
  | "CONTRATO_JA_ASSINADO"
  | "STATUS_CONTRATO_NAO_PERMITE_ASSINATURA"
  | "VERSAO_CONTRATO_DIVERGENTE"
  | "DOCUMENTO_CONTRATO_DIVERGENTE"
  | "DOCUMENTO_CONTRATO_INTEGRIDADE_FALHOU"
  | "MODELO_CONTRATO_OFICIAL_NAO_DISPONIVEL"
  | "TEMPLATE_CONTRATUAL_NAO_HOMOLOGADO"
  | "DADOS_CONTRATUAIS_INCONSISTENTES";

export class ContratoServiceError extends Error {
  public readonly code: ContratoServiceErrorCode;
  public readonly httpStatus: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: ContratoServiceErrorCode,
    message: string,
    httpStatus = 400,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ContratoServiceError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export function isContratoServiceError(
  error: unknown,
): error is ContratoServiceError {
  return error instanceof ContratoServiceError;
}
