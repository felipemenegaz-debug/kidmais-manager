/**
 * Erros da pesquisa de satisfação. Mensagem sempre segura para a página pública: token inválido, expirado, revogado e
 * inexistente recebem a MESMA resposta (LINK_INDISPONIVEL), sem distinguir o motivo.
 */
export class SatisfacaoError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details: Record<string, unknown> | null;
  constructor(code: string, message: string, httpStatus = 400, details: Record<string, unknown> | null = null) {
    super(message);
    this.name = "SatisfacaoError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export function isSatisfacaoError(error: unknown): error is SatisfacaoError {
  return error instanceof SatisfacaoError;
}

export const MENSAGEM_INDISPONIVEL = "Este link de pesquisa não está mais disponível.";

/** Resposta genérica para qualquer link que não serve (formato, assinatura, envio, validade, festa). */
export function linkIndisponivel(): never {
  throw new SatisfacaoError("LINK_INDISPONIVEL", MENSAGEM_INDISPONIVEL, 404);
}

/** Configuração do anel de chaves ausente ou malformada: falha fechada, sem detalhe (503). */
export function configuracaoIndisponivel(): never {
  throw new SatisfacaoError("PESQUISA_INDISPONIVEL", "A pesquisa está indisponível no momento.", 503);
}
