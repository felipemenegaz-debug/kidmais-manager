/**
 * Erros do painel do desenvolvedor, de convites, de recuperação e de troca de senha.
 * A mensagem é sempre apresentável ao usuário: nunca leva senha, token, hash ou link.
 */
export type AcessoErroCodigo =
    | 'DADOS_INVALIDOS'
    | 'NAO_ENCONTRADO'
    | 'CONFLITO'
    | 'DUPLICIDADE'
    | 'REVISAO_DESATUALIZADA'
    | 'REAUTENTICACAO'
    | 'LIMITE_TENTATIVAS'
    | 'SENHA_ATUAL_INCORRETA'
    | 'SENHA_INVALIDA'
    | 'LINK_INVALIDO'
    | 'EMAIL_NAO_CONFIGURADO'
    | 'EMAIL_FALHOU'
    | 'ULTIMA_GESTAO'
    | 'ULTIMA_ADMINISTRADORA'
    | 'IMPLANTACAO_PENDENTE'
    | 'PAINEL_INDISPONIVEL';

export class AcessoServiceError extends Error {
    readonly code: AcessoErroCodigo;
    readonly httpStatus: number;
    readonly details?: Record<string, unknown>;

    constructor(code: AcessoErroCodigo, message: string, httpStatus = 400, details?: Record<string, unknown>) {
        super(message);
        this.name = 'AcessoServiceError';
        this.code = code;
        this.httpStatus = httpStatus;
        this.details = details;
    }
}

export function isAcessoServiceError(error: unknown): error is AcessoServiceError {
    return error instanceof AcessoServiceError;
}

export function erroAcesso(code: AcessoErroCodigo, message: string, httpStatus = 400, details?: Record<string, unknown>) {
    return new AcessoServiceError(code, message, httpStatus, details);
}

/** PostgreSQL: violação de unicidade. */
export function violacaoUnica(error: unknown, restricao?: string) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== '23505')
        return false;
    return !restricao || ('constraint' in error && error.constraint === restricao);
}

/** PostgreSQL: tabela inexistente (migration 063 não aplicada neste banco). */
export function tabelaAusente(error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01';
}
