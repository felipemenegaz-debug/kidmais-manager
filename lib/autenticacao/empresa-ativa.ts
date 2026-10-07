import { withTransaction } from '../db/postgres.ts';
import { authError, consultarSessao, criarSessaoAdministrativa } from './service.ts';
import { provarTenant, revalidarTenant } from '../saas/provar-tenant.ts';
import { registrarAuditoria } from '../clientes/repositories/auditoria.repository.ts';

/** A escolha só admite vínculo ativo. Token/CSRF rotacionam, sem renovar autenticação ou prazo absoluto. */
export async function selecionarEmpresaAtiva(token: string, empresaId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(empresaId))
        throw authError('Selecione uma empresa válida.', 400);
    return withTransaction(async (tx) => {
        const atual = await consultarSessao(token, tx, true);
        const instalada = (await tx.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public'
            AND table_name='sessoes_administrativas' AND column_name='empresa_ativa_id'`)).rows.length > 0;
        if (!instalada) throw authError('A seleção de empresa ainda não está instalada.', 409);
        // A escolha explícita é a única operação que pode sair do contexto da sessão atual.
        const tenant = await provarTenant(tx, { usuario_id: atual.usuario_id, papel: atual.papel }, empresaId.toLowerCase());
        await tx.query('UPDATE sessoes_administrativas SET revogado_em=clock_timestamp() WHERE id=$1', [atual.id]);
        const nova = await criarSessaoAdministrativa(tx, atual.usuario_id, null, null);
        await tx.query(`UPDATE sessoes_administrativas SET empresa_ativa_id=$2::uuid,
            criado_em=$3::timestamptz, autenticado_em=$3::timestamptz, expira_em=$4::timestamptz WHERE id=$1::uuid`,
        [nova.id, tenant.empresaComprovada, atual.autenticado_em, atual.expira_em]);
        await revalidarTenant(tx, tenant);
        await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: atual.usuario_id, acao: 'ADMIN_EMPRESA_SELECIONADA',
            entidadeTipo: 'SESSAO_ADMINISTRATIVA', entidadeId: nova.id, origem: 'ADMIN_AUTENTICACAO',
            dadosDepois: { empresaId: tenant.empresaComprovada } }, tx);
        return { ...nova, expires: new Date(atual.expira_em) };
    });
}
