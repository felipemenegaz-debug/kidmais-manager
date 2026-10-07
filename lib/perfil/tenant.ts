import type { DbExecutor } from '../db/contracts.ts';
import { EMPRESA_SAAS_DO_PERFIL } from './autorizacao.ts';
import { ClienteServiceError } from '../clientes/services/errors.ts';

const PERFIS_SQL = `SELECT p.id::text AS id FROM public.perfil_empresas p
        JOIN LATERAL (${EMPRESA_SAAS_DO_PERFIL}) e ON e.candidatos=1 AND e.status='ATIVA'
        WHERE e.id=$1::uuid`;

/**
 * UUID legado do perfil só é resolvido depois da prova do tenant da sessão.
 * Nenhum perfil associado → null (empresa nova, ainda sem perfil: a Gestão pode criá-lo em lib/perfil/criacao.ts).
 * Mais de um perfil associado → 409 (ambiguidade fecha o acesso; nunca escolhe um deles).
 */
export async function perfilDoTenantOuNulo(tx: DbExecutor, empresaSaasId: string): Promise<string | null> {
    const perfis = await tx.query<{ id: string }>(PERFIS_SQL, [empresaSaasId]);
    if (perfis.rows.length > 1)
        throw new ClienteServiceError('PERFIL_ESTRUTURA_AUSENTE', 'O perfil desta empresa ainda não está disponível.', 409);
    return perfis.rows[0]?.id ?? null;
}

/** Como `perfilDoTenantOuNulo`, mas a ausência também recusa (fluxos que exigem o perfil já existente). */
export async function perfilDoTenant(tx: DbExecutor, empresaSaasId: string) {
    const perfil = await perfilDoTenantOuNulo(tx, empresaSaasId);
    if (!perfil)
        throw new ClienteServiceError('PERFIL_ESTRUTURA_AUSENTE', 'O perfil desta empresa ainda não está disponível.', 409);
    return perfil;
}
