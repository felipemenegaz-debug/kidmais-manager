import type { DbExecutor } from '../db/contracts';
import { isAcessoServiceError } from '../acessos/erros.ts';
import { ClienteServiceError } from '../clientes/services/errors.ts';
import { planoConfirmado } from './limites-usuarios.ts';
import type { PlanoComercialId } from './planos-comerciais.ts';

/**
 * Recursos que dependem do plano contratado (servidor). A vitrine (lib/site/catalogo.ts) descreve a oferta;
 * esta matriz é a barreira. Só contrato confirmado restringe: teste, legado e empresa isenta usam tudo o que está
 * disponível. A situação comercial (pagamento, leitura, suspensão) continua decidida pelo paywall, separadamente.
 *
 *   FINANCEIRO_COMPLETO → contas a pagar, fluxo de caixa e relatórios. Pix e contas a receber são de todos os planos.
 */
export const RECURSOS_POR_PLANO = {
    FINANCEIRO_COMPLETO: ['profissional', 'premium'],
} as const satisfies Record<string, readonly PlanoComercialId[]>;
export type RecursoPlano = keyof typeof RECURSOS_POR_PLANO;

const NOME: Record<RecursoPlano, string> = { FINANCEIRO_COMPLETO: 'Contas a pagar, fluxo de caixa e relatórios' };

export function planoIncluiRecurso(plano: PlanoComercialId, recurso: RecursoPlano) {
    return (RECURSOS_POR_PLANO[recurso] as readonly PlanoComercialId[]).includes(plano);
}

/** true quando a empresa pode usar o recurso. Falha de leitura do contrato recusa (503), nunca concede. */
export async function recursoIncluido(tx: DbExecutor, empresaId: string, recurso: RecursoPlano) {
    let plano: PlanoComercialId | null;
    try {
        plano = await planoConfirmado(tx, empresaId);
    } catch (error) {
        if (isAcessoServiceError(error) && error.code === 'PLANOS_NAO_DISPONIVEIS')
            throw new ClienteServiceError('PLANOS_NAO_DISPONIVEIS', error.message, 503);
        throw error;
    }
    return plano === null || planoIncluiRecurso(plano, recurso);
}

/** Recusa com 403 RECURSO_FORA_DO_PLANO. A empresa vem do tenant comprovado, nunca do navegador. */
export async function exigirRecursoPlano(tx: DbExecutor, empresaId: string, recurso: RecursoPlano) {
    if (!await recursoIncluido(tx, empresaId, recurso))
        throw new ClienteServiceError('RECURSO_FORA_DO_PLANO', `${NOME[recurso]} não fazem parte do plano contratado. Os dados já cadastrados continuam guardados.`, 403, { recurso });
}
