import type { DbExecutor } from '../db/contracts.ts';
import { EMPRESA_SAAS_DO_PERFIL } from './autorizacao.ts';
import { ClienteServiceError } from '../clientes/services/errors.ts';

/** UUID legado do perfil só é resolvido depois da prova do tenant da sessão. */
export async function perfilDoTenant(tx: DbExecutor, empresaSaasId: string) {
    const perfis = await tx.query<{ id: string }>(`SELECT p.id::text AS id FROM public.perfil_empresas p
        JOIN LATERAL (${EMPRESA_SAAS_DO_PERFIL}) e ON e.candidatos=1 AND e.status='ATIVA'
        WHERE e.id=$1::uuid`, [empresaSaasId]);
    if (perfis.rows.length !== 1)
        throw new ClienteServiceError('PERFIL_ESTRUTURA_AUSENTE', 'O perfil desta empresa ainda não está disponível.', 409);
    return perfis.rows[0].id;
}
