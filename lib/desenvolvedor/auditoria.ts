import type { DbExecutor } from '../db/contracts';
import type { AppendAuditoriaInput } from '../clientes/repositories/auditoria.repository';
import { mascararDocumento } from '../acessos/validacao.ts';

/**
 * Auditoria do painel do desenvolvedor: ator, horário (criado_em do banco), empresa, ação, resultado e campos
 * alterados. Sanitização em duas camadas: os chamadores montam listas brancas e `sanitizarAuditoria` ainda remove
 * qualquer chave sensível (senha, token, hash, link/URL, segredo, cookie, CSRF) e mascara documento fiscal.
 */
export const ORIGEM_PAINEL = 'PAINEL_DESENVOLVEDOR';
const CHAVE_PROIBIDA = /senha|password|token|hash|link|url|segredo|secret|cookie|csrf|credencial/i;

export function sanitizarAuditoria(valor: unknown, profundidade = 0): unknown {
    if (profundidade > 4)
        return '[omitido]';
    if (Array.isArray(valor))
        return valor.slice(0, 50).map((item) => sanitizarAuditoria(item, profundidade + 1));
    if (valor && typeof valor === 'object') {
        const saida: Record<string, unknown> = {};
        for (const [chave, item] of Object.entries(valor)) {
            if (CHAVE_PROIBIDA.test(chave))
                continue;
            saida[chave] = /documento/i.test(chave) && (typeof item === 'string' || item === null)
                ? mascararDocumento(item as string | null)
                : sanitizarAuditoria(item, profundidade + 1);
        }
        return saida;
    }
    if (typeof valor === 'string')
        return valor.length > 500 ? `${valor.slice(0, 500)}…` : valor;
    return valor;
}

/** Campos que mudaram entre dois objetos (só as chaves pedidas). */
export function diferencas<T extends Record<string, unknown>>(antes: T, depois: Partial<T>, chaves: readonly (keyof T)[]) {
    const a: Record<string, unknown> = {}, d: Record<string, unknown> = {};
    for (const chave of chaves) {
        if (!(chave in depois))
            continue;
        if (JSON.stringify(antes[chave] ?? null) !== JSON.stringify(depois[chave] ?? null)) {
            a[chave as string] = antes[chave] ?? null;
            d[chave as string] = depois[chave] ?? null;
        }
    }
    return { antes: a, depois: d, alterados: Object.keys(d) };
}

export type ContextoPainel = { requestId: string; ip: string | null; userAgent: string | null };
export type RegistrarAuditoria = (input: AppendAuditoriaInput, tx?: DbExecutor) => Promise<unknown>;

export async function auditarPainel(registrar: RegistrarAuditoria, tx: DbExecutor | undefined, input: {
    atorId: string;
    acao: string;
    entidadeTipo: string;
    entidadeId: string;
    empresaId?: string | null;
    resultado: 'SUCESSO' | 'RECUSADO' | 'FALHA' | 'PARCIAL';
    antes?: Record<string, unknown> | null;
    depois?: Record<string, unknown> | null;
    justificativa?: string | null;
    ctx: ContextoPainel;
}) {
    const depois = sanitizarAuditoria({ ...(input.depois ?? {}), empresaId: input.empresaId ?? null, resultado: input.resultado }) as Record<string, unknown>;
    const antes = input.antes ? sanitizarAuditoria(input.antes) as Record<string, unknown> : null;
    await registrar({
        atorTipo: 'USUARIO', usuarioId: input.atorId, acao: input.acao, entidadeTipo: input.entidadeTipo, entidadeId: input.entidadeId,
        dadosAntes: antes, dadosDepois: depois, justificativa: input.justificativa ? String(sanitizarAuditoria(input.justificativa)) : null,
        origem: ORIGEM_PAINEL, requestId: input.ctx.requestId, ip: input.ctx.ip, userAgent: input.ctx.userAgent,
    }, tx);
}
