export type ClienteServiceErrorCode =
  | "AUTENTICACAO_ADMINISTRATIVA"
  | "DADOS_INVALIDOS"
  | "CPF_EXISTENTE"
  | "CLIENTE_NAO_ENCONTRADO"
  | "ALTERACAO_CPF_REQUER_PERMISSAO"
  | "CLIENTE_MESCLADO"
  | "API_ADMIN_AGUARDANDO_AUTENTICACAO";

export class ClienteServiceError extends Error {
  constructor(
    public readonly code: ClienteServiceErrorCode,
    message: string,
    public readonly httpStatus = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ClienteServiceError";
  }
}

export function isClienteServiceError(error: unknown): error is ClienteServiceError {
  return error instanceof ClienteServiceError;
}
