import type { Papel } from './service.ts';

/**
 * Autoridade de PLATAFORMA — recursos da instalação inteira, sem empresa: a tabela PDF pública e a
 * configuração do WhatsApp/Meta. Não é autoridade de empresa (essa vive em `memberships.papel`).
 *
 * Não existe Platform Admin separado: a autoridade é o papel legado da IDENTIDADE global
 * (`usuarios_administrativos.papel = REPRESENTANTE_AUTORIZADO`), concedido só pelo provisionamento do
 * operador fora da aplicação (`scripts/admin-provision.cjs`, terminal local com acesso ao banco). Nenhuma
 * rota de tenant grava, eleva ou altera esse papel: a criação por empresa nasce com `PAPEL_GLOBAL_NEUTRO`.
 * O papel de membership nunca conta aqui.
 */
export const PAPEL_PLATAFORMA: Papel = 'REPRESENTANTE_AUTORIZADO';

/** Papel da identidade criada por um fluxo de empresa: sem autoridade de plataforma. */
export const PAPEL_GLOBAL_NEUTRO: Papel = 'ADMINISTRATIVO';

export function temAutoridadeDePlataforma(sessao: { papel: string }) {
    return sessao.papel === PAPEL_PLATAFORMA;
}
