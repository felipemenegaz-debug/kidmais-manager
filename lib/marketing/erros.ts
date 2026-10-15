/**
 * Erros do módulo Marketing. Mensagem sempre segura para a tela (sem detalhe interno, sem dado de outra empresa).
 * Tratado por lib/http/api-response.ts (apiErrorResponse) como os demais erros de serviço.
 */
export class MarketingError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details: Record<string, unknown> | null;
  constructor(code: string, message: string, httpStatus = 400, details: Record<string, unknown> | null = null) {
    super(message);
    this.name = "MarketingError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export function isMarketingError(error: unknown): error is MarketingError {
  return error instanceof MarketingError;
}

/** Registro de outra empresa, inexistente ou arquivado: a mesma resposta, sem distinguir. */
export function naoEncontrado(mensagem = "Registro indisponível nesta empresa."): never {
  throw new MarketingError("MARKETING_NAO_ENCONTRADO", mensagem, 404);
}

/** Edição concorrente (versão otimista divergente). */
export function conflito(mensagem = "Este registro foi alterado por outra pessoa. Recarregue antes de salvar."): never {
  throw new MarketingError("MARKETING_CONFLITO", mensagem, 409);
}

/** Tabelas da 083/084 ausentes neste banco: indisponível, sem detalhe do schema. */
export function schemaAusente(error: unknown): MarketingError | null {
  const e = error as { code?: unknown; message?: unknown };
  if (e?.code === "42P01" && typeof e.message === "string" && /marketing_/.test(e.message)) {
    const migration = /marketing_(automacao|tarefas|contato_preferencias|contato_autorizacoes|transporte_simulado)/.test(e.message) ? "084" : "083";
    return new MarketingError("MARKETING_INDISPONIVEL", `Marketing indisponível neste ambiente: a migration ${migration} ainda não foi aplicada.`, 503);
  }
  return null;
}
