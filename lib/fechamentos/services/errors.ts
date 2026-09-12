export type FechamentoServiceErrorCode =
  | "REVISAO_COMERCIAL_INVALIDA"
  | "FECHAMENTO_NAO_ENCONTRADO"
  | "DADOS_INVALIDOS"
  | "VALOR_PROPOSTO_INVALIDO"
  | "IDENTIDADE_OBRIGATORIA"
  | "CPF_DIVERGENTE_DA_IDENTIDADE"
  | "CPF_EXISTENTE_REQUER_VALIDACAO"
  | "ANIVERSARIANTE_INVALIDO"
  | "CADASTRO_INCOMPLETO"
  | "FLUXO_INTERNO_NAO_AUTORIZADO"
  | "PACOTE_FORA_ESCOPO_V1";

export class FechamentoServiceError extends Error {
  constructor(
    public readonly code: FechamentoServiceErrorCode,
    message: string,
    public readonly httpStatus = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FechamentoServiceError";
  }
}

export function isFechamentoServiceError(
  error: unknown,
): error is FechamentoServiceError {
  return error instanceof FechamentoServiceError;
}
