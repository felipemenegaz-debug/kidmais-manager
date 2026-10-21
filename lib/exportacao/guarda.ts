import type { DbExecutor } from '../db/contracts';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';
import { exigirGestaoNoTenant, provarTenant, revalidarTenant, travarUsuariosNaOrdem, type SessaoParaTenant, type TenantComprovado } from '../saas/provar-tenant.ts';

/**
 * Guarda da EXPORTAÇÃO (e só dela). Empresa ATIVA: exatamente provarTenant + Gestão (nada muda). Empresa SUSPENSA
 * administrativamente (painel do desenvolvedor): exceção mínima para a Gestão continuar levando os próprios dados —
 * exigência do parecer da Astra (ajuste 6, L2: "não bloquear a exportação") e da devolução de dados do DPA.
 *
 * A exceção vale só quando TODAS as condições se cumprem, na mesma transação e com as mesmas travas de provarTenant
 * (usuário → empresa → membership):
 *   - a empresa foi pedida explicitamente (empresaId) e está SUSPENSA (nunca DESATIVADA nem PROVISIONAMENTO);
 *   - a pessoa está ativa e a sessão continua válida (revogada, expirada ou com contexto mudado = recusa);
 *   - a sessão não está selecionada em OUTRA empresa — salvo no pedido explícito do pacote completo (POST com CSRF,
 *     `permitirSelecaoNoutraEmpresa`): a Gestão que trabalha na empresa ativa A baixa a suspensa B sem sair e entrar;
 *     a sessão continua em A (nada muda de contexto) e os CSVs avulsos por GET seguem a regra estrita;
 *   - o vínculo DESSA empresa está ATIVA e o papel é Gestão (REPRESENTANTE_AUTORIZADO); Equipe nunca;
 * e só é usada pela rota de exportação (GET, somente leitura + auditoria). Nenhuma outra rota chama esta guarda; um
 * teste estático confere. A suspensão continua cortando todo o resto (provarTenant segue só com empresa ATIVA).
 */
export type TenantExportacao = TenantComprovado & { suspensa: boolean };
export type OpcoesGuarda = { permitirSelecaoNoutraEmpresa?: boolean };

function recusar(): never {
    throw new PacoteAdminError('TENANT_NAO_COMPROVADO', 'A sessão administrativa não comprova a empresa autorizada.', 403);
}
const MENSAGEM_GESTAO = 'Só a Gestão da empresa exporta os dados.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ehRecusaDeTenant(erro: unknown) {
    return erro instanceof PacoteAdminError && erro.code === 'TENANT_NAO_COMPROVADO';
}

async function provarSuspensa(tx: DbExecutor, sessao: SessaoParaTenant, pedida: string, opcoes: OpcoesGuarda): Promise<TenantExportacao> {
    // Sessão selecionada em outra empresa: um parâmetro não troca de contexto (mesma regra de provarTenant), exceto no
    // pedido explícito e protegido por CSRF do pacote completo.
    if (sessao.empresa_ativa_id && sessao.empresa_ativa_id !== pedida && opcoes.permitirSelecaoNoutraEmpresa !== true) recusar();
    await travarUsuariosNaOrdem(tx, [sessao.usuario_id]);
    const usuario = await tx.query<{ ativo: boolean }>('SELECT ativo FROM usuarios_administrativos WHERE id = $1::uuid', [sessao.usuario_id]);
    if (usuario.rows[0]?.ativo !== true) recusar();
    if (sessao.id && sessao.empresa_ativa_id !== undefined) {
        const atual = await tx.query<{ empresa_ativa_id: string | null }>(
            `SELECT to_jsonb(s)->>'empresa_ativa_id' AS empresa_ativa_id FROM sessoes_administrativas s
              WHERE s.id = $1::uuid AND s.usuario_id = $2::uuid AND s.revogado_em IS NULL AND s.expira_em > clock_timestamp()`,
            [sessao.id, sessao.usuario_id]);
        if (!atual.rows[0] || atual.rows[0].empresa_ativa_id !== sessao.empresa_ativa_id) recusar();
    }
    const empresa = await tx.query<{ status: string }>('SELECT status FROM empresas WHERE id = $1::uuid FOR UPDATE', [pedida]);
    if (empresa.rows[0]?.status !== 'SUSPENSA') recusar();
    const vinculo = await tx.query<{ id: string; papel: string }>(
        `SELECT m.id::text AS id, m.papel FROM memberships m
          WHERE m.usuario_id = $1::uuid AND m.empresa_id = $2::uuid AND m.status = 'ATIVA'
          FOR UPDATE OF m`, [sessao.usuario_id, pedida]);
    const linha = vinculo.rows[0];
    if (!linha || typeof linha.papel !== 'string' || linha.papel === '') recusar();
    const tenant: TenantExportacao = { empresaComprovada: pedida, membershipId: linha.id, usuarioId: sessao.usuario_id, papelAtual: linha.papel, suspensa: true };
    exigirGestaoNoTenant(tenant, MENSAGEM_GESTAO);
    return tenant;
}

/** Prova o tenant da exportação dentro da transação aberta. Empresa ativa → provarTenant; suspensa → exceção acima. */
export async function provarTenantParaExportacao(tx: DbExecutor, sessao: SessaoParaTenant, empresaSolicitada?: string | null, opcoes: OpcoesGuarda = {}): Promise<TenantExportacao> {
    const pedida = empresaSolicitada?.trim() ? empresaSolicitada.trim().toLowerCase() : null;
    if (pedida !== null && !UUID.test(pedida)) recusar();
    try {
        const tenant = await provarTenant(tx, sessao, pedida);
        exigirGestaoNoTenant(tenant, MENSAGEM_GESTAO);
        return { ...tenant, suspensa: false };
    } catch (erro) {
        // Só a recusa de tenant abre a verificação da suspensa, e só com empresa pedida explicitamente.
        if (!ehRecusaDeTenant(erro) || pedida === null) throw erro;
    }
    return provarSuspensa(tx, sessao, pedida, opcoes);
}

/** Relê, antes do commit, as condições que valiam na prova (a empresa não pode ter mudado de situação no meio). */
export async function revalidarTenantExportacao(tx: DbExecutor, tenant: TenantExportacao): Promise<void> {
    if (!tenant.suspensa) {
        await revalidarTenant(tx, tenant);
        return;
    }
    await travarUsuariosNaOrdem(tx, [tenant.usuarioId]);
    const usuario = await tx.query<{ ativo: boolean }>('SELECT ativo FROM usuarios_administrativos WHERE id = $1::uuid', [tenant.usuarioId]);
    if (usuario.rows[0]?.ativo !== true) recusar();
    const empresa = await tx.query<{ status: string }>('SELECT status FROM empresas WHERE id = $1::uuid FOR UPDATE', [tenant.empresaComprovada]);
    if (empresa.rows[0]?.status !== 'SUSPENSA') recusar();
    const atual = await tx.query<{ status: string; papel: string }>(
        `SELECT m.status, m.papel FROM memberships m WHERE m.id = $1::uuid AND m.usuario_id = $2::uuid AND m.empresa_id = $3::uuid FOR UPDATE`,
        [tenant.membershipId, tenant.usuarioId, tenant.empresaComprovada]);
    if (atual.rows[0]?.status !== 'ATIVA' || atual.rows[0]?.papel !== 'REPRESENTANTE_AUTORIZADO') recusar();
}

/** Empresas SUSPENSAS em que a pessoa é Gestão com vínculo ativo (só id e nome), para a tela oferecer a exportação. */
export async function empresasSuspensasExportaveis(tx: DbExecutor, usuarioId: string): Promise<{ id: string; nome: string }[]> {
    return (await tx.query<{ id: string; nome: string }>(
        `SELECT e.id::text AS id, e.nome FROM memberships m JOIN empresas e ON e.id = m.empresa_id JOIN usuarios_administrativos u ON u.id = m.usuario_id
          WHERE m.usuario_id = $1::uuid AND u.ativo AND m.status = 'ATIVA' AND m.papel = 'REPRESENTANTE_AUTORIZADO' AND e.status = 'SUSPENSA'
          ORDER BY e.nome, e.id`, [usuarioId])).rows;
}
