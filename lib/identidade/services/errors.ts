export type IdentityServiceErrorCode =
  | "CPF_INVALIDO"
  | "CLIENTE_NAO_ENCONTRADO"
  | "CANAL_INDISPONIVEL"
  | "VALIDACAO_NAO_ENCONTRADA"
  | "VALIDACAO_NAO_PENDENTE"
  | "CODIGO_EXPIRADO"
  | "CODIGO_INVALIDO"
  | "CODIGO_BLOQUEADO"
  | "PROVA_INVALIDA_OU_EXPIRADA"
  | "PROVA_FINALIDADE_INVALIDA"
  | "CONFIGURACAO_IDENTIDADE_INVALIDA"
  | "OTP_INDISPONIVEL"
  | "FALHA_ENVIO_OTP";

export class IdentityServiceError extends Error {
  constructor(
    public readonly code: IdentityServiceErrorCode,
    message: string,
    public readonly httpStatus = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "IdentityServiceError";
  }
}

export function isIdentityServiceError(
  error: unknown,
): error is IdentityServiceError {
  return error instanceof IdentityServiceError;
}
