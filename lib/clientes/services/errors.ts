export type ClienteServiceErrorCode =
  | "AUTENTICACAO_ADMINISTRATIVA"
  | "DADOS_INVALIDOS"
  | "CPF_EXISTENTE"
  | "CPF_INDISPONIVEL"
  | "CLIENTE_NAO_ENCONTRADO"
  | "ALTERACAO_CPF_REQUER_PERMISSAO"
  | "CLIENTE_MESCLADO"
  | "API_ADMIN_AGUARDANDO_AUTENTICACAO"
  | "PERFIL_ULTIMA_ADMINISTRADORA"
  | "PERFIL_ULTIMA_GESTAO"
  | "PERFIL_SEM_CONCESSAO"
  | "PERFIL_REAUTENTICACAO"
  | "PERFIL_ESTRUTURA_AUSENTE"
  | "PERFIL_CONTA_AUSENTE"
  | "PERFIL_OPERADOR_OBRIGATORIO"
  | "PERFIL_CONFLITO"
  | "PERFIL_CADASTRO_INVALIDO"
  | "PERFIL_LOGO_INVALIDA"
  | "PERFIL_LIMITE_V1"
  | "ASSINATURA_NECESSARIA"
  | "RECURSO_FORA_DO_PLANO"
  | "PLANOS_NAO_DISPONIVEIS";

export class ClienteServiceError extends Error {
  readonly code: ClienteServiceErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ClienteServiceErrorCode,
    message: string,
    httpStatus = 400,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ClienteServiceError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export function isClienteServiceError(error: unknown): error is ClienteServiceError {
  return error instanceof ClienteServiceError;
}
