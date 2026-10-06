import { z } from 'zod';
import type { DbExecutor } from '../db/contracts';
import { withTransaction as withTransactionPadrao } from '../db/postgres';
import { registrarAuditoria as registrarAuditoriaPadrao } from '../clientes/repositories/auditoria.repository';
import { authError, type SessaoAdmin } from './service.ts';
import { criarHashSenha as criarHashSenhaPadrao, senhaValida } from './senha.ts';
import { nomePapelSistema, papelDeNivel, type NivelSistema } from './papeis.ts';
import { perfis } from '../festas/perfis.ts';
import { ClienteServiceError } from '../clientes/services/errors.ts';
import { avaliarPerdaDeElegibilidade, MENSAGEM_ULTIMA_ADMINISTRADORA, revogarConcessoesAtivasDoUsuario } from '../perfil/protecao-usuarios.ts';
import { executarNoTenant, type TenantComprovado } from '../saas/provar-tenant.ts';
import { PAPEL_GLOBAL_NEUTRO } from './plataforma.ts';
import { erroAcesso } from '../acessos/erros.ts';

export type UsuariosDeps = {
    withTransaction: typeof withTransactionPadrao;
    criarHashSenha: typeof criarHashSenhaPadrao;
    registrarAuditoria: typeof registrarAuditoriaPadrao;
    /** E1: a criação direta (senha definida pela Gestão) ainda está permitida? Padrão: USUARIOS_CRIACAO_DIRETA. */
    criacaoDireta?: () => boolean;
};

const padrao: UsuariosDeps = {
    withTransaction: withTransactionPadrao,
    criarHashSenha: criarHashSenhaPadrao,
    registrarAuditoria: registrarAuditoriaPadrao,
};
export type ContaAdministrativa = {
    id: string;
    nome: string;
    email: string;
    papel: SessaoAdmin['papel'];
    nivelSistema: 'Gestão' | 'Equipe';
    ativo: boolean;
};

function exigirGestao(sessao: SessaoAdmin) {
    if (sessao.papel !== 'REPRESENTANTE_AUTORIZADO')
        throw authError('Somente a Gestão pode administrar usuários.', 403);
}

function isPgUniqueViolation(error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

const criarSchema = z.object({
    acao: z.literal('criar'),
    nome: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(254),
    nivel: z.enum(['GESTAO', 'EQUIPE']),
    senha: z.string().max(512),
    confirmacao: z.string().max(512),
}).strict();

const desativarSchema = z.object({
    acao: z.literal('desativar'),
    usuarioId: z.string().uuid().transform((value) => value.toLowerCase()),
    confirmar: z.literal(true),
}).strict();

function conta(row: { id: string; nome: string; email: string; papel: SessaoAdmin['papel']; ativo: boolean }): ContaAdministrativa {
    return { id: row.id, nome: row.nome, email: row.email, papel: row.papel, nivelSistema: nomePapelSistema(row.papel), ativo: row.ativo };
}

/**
 * 056 — administração de contas NA EMPRESA (decisão de produto 2026-09-29).
 *
 * Identidade (usuarios_administrativos) é global; o acesso a uma empresa é a membership. Toda operação daqui
 * roda na transação do tenant: provarTenant (usuário, empresa, membership e papel NESTA empresa travados) →
 * Gestão nesta empresa (papel da membership) → só memberships desta empresa → revalidarTenant → commit.
 * Nunca lista, altera nem desativa a identidade global; nunca toca membership de outra empresa.
 * F1/F2: nunca concede autoridade de plataforma (identidade nova nasce com papel global neutro) e nunca devolve
 * dado da identidade global além do que a tela da empresa administra (situação = a da membership desta empresa).
 */
export type MembroDaEmpresa = ContaAdministrativa & {
    membershipId: string;
    statusMembership: 'PENDENTE' | 'ATIVA' | 'SUSPENSA' | 'REVOGADA';
    /** 057: capability CONTRATO_ASSINAR_EMPRESA ativa nesta membership. */
    podeAssinar: boolean;
};
type LinhaMembro = { id: string; nome: string; email: string; papel: SessaoAdmin['papel']; membership_id: string; status: MembroDaEmpresa['statusMembership']; pode_assinar?: boolean };

function membro(row: LinhaMembro): MembroDaEmpresa {
    return {
        id: row.id, nome: row.nome, email: row.email, papel: row.papel, nivelSistema: nomePapelSistema(row.papel),
        ativo: row.status === 'ATIVA', membershipId: row.membership_id, statusMembership: row.status,
        podeAssinar: row.status === 'ATIVA' && row.pode_assinar === true,
    };
}

const MEMBROS_SQL = `SELECT u.id, u.nome, u.email, m.papel, m.id AS membership_id, m.status,
         EXISTS (SELECT 1 FROM empresa_membership_capacidades c WHERE c.membership_id = m.id AND c.empresa_id = m.empresa_id
                  AND c.capacidade = 'CONTRATO_ASSINAR_EMPRESA' AND c.revogado_em IS NULL) AS pode_assinar
    FROM memberships m JOIN usuarios_administrativos u ON u.id = m.usuario_id
   WHERE m.empresa_id = $1::uuid`;

function emTenant<T>(sessao: SessaoAdmin, empresaSolicitada: string | null | undefined, deps: UsuariosDeps, trabalho: (tx: DbExecutor, tenant: TenantComprovado) => Promise<T>) {
    return deps.withTransaction((tx) => executarNoTenant(tx, sessao, empresaSolicitada, async (txTenant, tenant) => {
        exigirGestaoDaEmpresa(tenant);
        return trabalho(txTenant, tenant);
    }));
}

function exigirGestaoDaEmpresa(tenant: TenantComprovado) {
    if (tenant.papelAtual !== 'REPRESENTANTE_AUTORIZADO')
        throw authError('Somente a Gestão pode administrar usuários.', 403);
}

export async function marcarAtor(tx: DbExecutor, usuarioId: string) {
    await tx.query("SELECT set_config('kidmais.ator_usuario_id', $1, true)", [usuarioId]);
}

/** Membership desta empresa, travada. Nunca devolve membership de outra empresa. */
async function membershipDaEmpresa(tx: DbExecutor, empresaId: string, usuarioId: string) {
    return (await tx.query<LinhaMembro>(`${MEMBROS_SQL} AND m.usuario_id = $2::uuid FOR UPDATE OF m`, [empresaId, usuarioId])).rows[0] ?? null;
}

/** Protege a empresa de ficar sem Gestão: a última membership ATIVA de representante não sai nem é rebaixada. */
export async function exigirOutraGestao(tx: DbExecutor, empresaId: string, usuarioId: string) {
    const outras = (await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM memberships m JOIN usuarios_administrativos u ON u.id = m.usuario_id
          WHERE m.empresa_id = $1::uuid AND m.usuario_id <> $2::uuid AND m.status = 'ATIVA' AND m.papel = 'REPRESENTANTE_AUTORIZADO' AND u.ativo`,
        [empresaId, usuarioId],
    )).rows[0].n;
    if (outras === 0)
        throw new ClienteServiceError('PERFIL_ULTIMA_GESTAO', 'Esta conta é a última Gestão desta empresa. Promova outra conta antes.', 409);
}

/** 057: revoga a assinatura pela empresa desta membership (rebaixamento ou saída da empresa). */
export async function revogarAssinaturaDaMembership(tx: DbExecutor, empresaId: string, membershipId: string, operadorId: string, motivo: string) {
    return (await tx.query<{ id: string }>(
        `UPDATE empresa_membership_capacidades SET revogado_por = $3, revogado_em = clock_timestamp(), motivo_revogacao = $4
          WHERE membership_id = $1::uuid AND empresa_id = $2::uuid AND capacidade = 'CONTRATO_ASSINAR_EMPRESA' AND revogado_em IS NULL RETURNING id`,
        [membershipId, empresaId, operadorId, motivo],
    )).rows.length;
}

export async function concederPerfilFesta(tx: DbExecutor, empresaId: string, membershipId: string, nivel: NivelSistema, operadorId: string) {
    const motivo = 'Perfil de Festa: ' + (nivel === 'GESTAO' ? 'Gestão' : 'Equipe');
    for (const capacidade of perfis[nivel]) {
        await tx.query(
            `INSERT INTO festa_membership_capacidades(empresa_id,membership_id,capacidade,concedido_por,motivo) VALUES($1,$2,$3,$4,$5)
             ON CONFLICT (membership_id, capacidade) WHERE revogado_em IS NULL DO NOTHING`,
            [empresaId, membershipId, capacidade, operadorId, motivo],
        );
    }
    return { capacidades: [...perfis[nivel]], motivo };
}

/**
 * Única criação de identidade da aplicação (F1): sempre com o papel global NEUTRO, sem autoridade de plataforma.
 * Usada pela criação na empresa e pelo aceite de convite (lib/acessos/convites.ts).
 */
export async function inserirIdentidadeNeutra(tx: DbExecutor, email: string, input: { nome: string }, senhaHash: string) {
    return (await tx.query<{ id: string }>(
        'INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel) VALUES($1,$2,$3,$4) RETURNING id',
        [email, input.nome, senhaHash, PAPEL_GLOBAL_NEUTRO],
    )).rows[0].id;
}

export async function listarUsuariosAdministrativos(sessao: SessaoAdmin, empresaSolicitada: string | null | undefined, deps: UsuariosDeps = padrao) {
    return emTenant(sessao, empresaSolicitada, deps, async (tx, tenant) => {
        const linhas = (await tx.query<LinhaMembro>(`${MEMBROS_SQL} ORDER BY (m.status = 'ATIVA') DESC, u.nome, u.email`, [tenant.empresaComprovada])).rows;
        return { usuarioId: sessao.usuario_id, usuarios: linhas.map(membro) };
    });
}

/**
 * E1 (venda por assinatura): a criação direta define a senha de outra pessoa e vincula conta já existente sem o
 * aceite dela. Com cadastro público isso não pode existir; o caminho é o convite (lib/acessos/convites-empresa.ts).
 * Enquanto o envio de e-mail não estiver configurado, a criação direta continua disponível para não interromper a
 * operação; USUARIOS_CRIACAO_DIRETA=desativada a encerra. O cadastro público só pode ser ligado com ela desativada.
 */
export function criacaoDiretaDisponivel(env: Record<string, string | undefined> = process.env) {
    return env.USUARIOS_CRIACAO_DIRETA?.trim().toLowerCase() !== 'desativada';
}

/** F2 — o que a criação devolve: só a membership recém-administrável desta empresa, igual para qualquer e-mail. */
export type AssociacaoNaEmpresa = {
    associado: true;
    membershipId: string;
    email: string;
    papel: SessaoAdmin['papel'];
    nivelSistema: 'Gestão' | 'Equipe';
    statusMembership: 'ATIVA';
    reutilizado: boolean;
};

/**
 * Adiciona a pessoa a ESTA empresa (decisão de produto: sem convite).
 *   - E-mail novo: identidade global com papel NEUTRO (`PAPEL_GLOBAL_NEUTRO`, sem autoridade de plataforma) +
 *     membership ATIVA com o papel pedido, na mesma transação. O papel da empresa vive só na membership.
 *   - E-mail existente (ativo ou não): nunca duplica nem altera a identidade (senha, nome, papel, situação);
 *     só cria/ativa a membership desta empresa. Identidade inativa continua sem entrar (a prova de tenant exige
 *     identidade ativa) — a empresa não fica sabendo.
 *   - Membership já ATIVA: idempotente. REVOGADA (terminal na 045): recusa coerente (dado desta empresa).
 * Anti-oráculo (F2): senha validada e hash calculado ANTES de saber se o e-mail existe (mesmas recusas e mesmo
 * custo); a resposta tem o mesmo formato nos dois casos e não leva id, nome, situação nem vínculos da identidade.
 */
export async function criarUsuarioAdministrativo(sessao: SessaoAdmin, raw: unknown, requestId: string, deps: UsuariosDeps = padrao, empresaSolicitada?: string | null): Promise<AssociacaoNaEmpresa> {
    if (!(deps.criacaoDireta ?? criacaoDiretaDisponivel)())
        throw erroAcesso('CRIACAO_DIRETA_DESATIVADA', 'Adicione pessoas por convite: a própria pessoa define a senha ao aceitar.', 403);
    const input = criarSchema.parse(raw);
    const email = input.email.trim().toLowerCase();
    const papel = papelDeNivel(input.nivel as NivelSistema);
    if (input.senha !== input.confirmacao)
        throw authError('A senha e a confirmação não conferem.', 400);
    if (!senhaValida(input.senha))
        throw authError('A senha deve ter entre 8 e 128 caracteres.', 400);
    const senhaHash = await deps.criarHashSenha(input.senha);
    const resposta = (membershipId: string, reutilizado: boolean): AssociacaoNaEmpresa => ({
        associado: true, membershipId, email, papel, nivelSistema: nomePapelSistema(papel) as AssociacaoNaEmpresa['nivelSistema'], statusMembership: 'ATIVA', reutilizado,
    });
    try {
        return await emTenant(sessao, empresaSolicitada, deps, async (tx, tenant) => {
            const empresaId = tenant.empresaComprovada;
            await marcarAtor(tx, sessao.usuario_id);
            const existente = (await tx.query<{ id: string }>(
                'SELECT id FROM usuarios_administrativos WHERE lower(btrim(email)) = lower(btrim($1)) FOR UPDATE',
                [email],
            )).rows[0];
            let usuarioId: string;
            let identidadeNova = false;
            if (existente) {
                usuarioId = existente.id;
            } else {
                usuarioId = await inserirIdentidadeNeutra(tx, email, input, senhaHash);
                identidadeNova = true;
            }
            const atual = await membershipDaEmpresa(tx, empresaId, usuarioId);
            if (atual?.status === 'REVOGADA')
                throw authError('O acesso desta conta a esta empresa foi removido e não é reaberto por aqui.', 409);
            // 063: vínculo desativado pela administração da plataforma volta só por reativação explícita no painel.
            if (atual?.status === 'SUSPENSA')
                throw authError('O acesso desta conta a esta empresa está desativado e não é reaberto por aqui.', 409);
            if (atual?.status === 'ATIVA')
                return resposta(atual.membership_id, true);
            let membershipId = atual?.membership_id;
            if (!membershipId) {
                membershipId = (await tx.query<{ id: string }>(
                    `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), $3) RETURNING id`,
                    [empresaId, usuarioId, papel],
                )).rows[0].id;
            } else {
                await tx.query('UPDATE memberships SET papel = $3 WHERE id = $1::uuid AND empresa_id = $2::uuid', [membershipId, empresaId, papel]);
            }
            await tx.query("UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid AND empresa_id = $2::uuid", [membershipId, empresaId]);
            const festa = await concederPerfilFesta(tx, empresaId, membershipId, input.nivel as NivelSistema, sessao.usuario_id);
            await deps.registrarAuditoria({
                atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: identidadeNova ? 'ADMIN_CRIAR' : 'MEMBERSHIP_ADICIONADA',
                entidadeTipo: 'MEMBERSHIP', entidadeId: membershipId,
                dadosDepois: { empresaId, membershipId, papel, status: 'ATIVA' }, origem: 'ADMIN_USUARIOS', requestId,
            }, tx);
            await deps.registrarAuditoria({
                atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'FESTA_PERFIL_APLICADO',
                entidadeTipo: 'MEMBERSHIP', entidadeId: membershipId,
                dadosDepois: { perfil: input.nivel, capacidades: festa.capacidades, empresaId, membershipId },
                justificativa: festa.motivo, origem: 'ADMIN_USUARIOS', requestId,
            }, tx);
            return resposta(membershipId, false);
        });
    } catch (error) {
        // Corrida entre dois cadastros do mesmo e-mail novo: resposta genérica (não confirma que o e-mail existe).
        if (isPgUniqueViolation(error))
            throw authError('Outra operação alterou este registro. Atualize e tente novamente.', 409);
        throw error;
    }
}

const papelSchema = z.object({
    acao: z.literal('papel'),
    usuarioId: z.string().uuid().transform((value) => value.toLowerCase()),
    nivel: z.enum(['GESTAO', 'EQUIPE']),
}).strict();

/** Papel NESTA empresa (memberships.papel). O papel da identidade e o de outras empresas não mudam. */
export async function alterarPapelNaEmpresa(sessao: SessaoAdmin, raw: unknown, requestId: string, deps: UsuariosDeps = padrao, empresaSolicitada?: string | null) {
    const input = papelSchema.parse(raw);
    if (input.usuarioId === sessao.usuario_id)
        throw authError('Você não pode alterar o próprio papel.', 403);
    const papel = papelDeNivel(input.nivel as NivelSistema);
    return emTenant(sessao, empresaSolicitada, deps, async (tx, tenant) => {
        const empresaId = tenant.empresaComprovada;
        const atual = await membershipDaEmpresa(tx, empresaId, input.usuarioId);
        if (!atual || atual.status !== 'ATIVA')
            throw authError('Conta não encontrada nesta empresa.', 404);
        if (atual.papel === papel)
            return { ...membro(atual), reutilizado: true };
        if (atual.papel === 'REPRESENTANTE_AUTORIZADO')
            await exigirOutraGestao(tx, empresaId, input.usuarioId);
        await tx.query('UPDATE memberships SET papel = $3 WHERE id = $1::uuid AND empresa_id = $2::uuid', [atual.membership_id, empresaId, papel]);
        // 057: assinar pela empresa exige Gestão; quem deixa a Gestão perde a assinatura (não fica adormecida).
        if (papel !== 'REPRESENTANTE_AUTORIZADO')
            await revogarAssinaturaDaMembership(tx, empresaId, atual.membership_id, sessao.usuario_id, 'Papel alterado para Equipe');
        const depois = membro({ ...atual, papel, pode_assinar: papel === 'REPRESENTANTE_AUTORIZADO' ? atual.pode_assinar : false });
        await deps.registrarAuditoria({
            atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'MEMBERSHIP_PAPEL_ALTERADO',
            entidadeTipo: 'MEMBERSHIP', entidadeId: atual.membership_id,
            dadosAntes: { papel: atual.papel, empresaId }, dadosDepois: { papel, empresaId }, origem: 'ADMIN_USUARIOS', requestId,
        }, tx);
        return { ...depois, reutilizado: false };
    });
}

const removerSchema = z.object({
    acao: z.literal('remover'),
    usuarioId: z.string().uuid().transform((value) => value.toLowerCase()),
    confirmar: z.literal(true),
}).strict();

/**
 * Remove o acesso da pessoa a ESTA empresa (membership REVOGADA, capacidades de Festa e do perfil desta empresa
 * revogadas). Não desativa a identidade, não encerra sessões globais e não toca outra empresa.
 */
export async function removerDaEmpresa(sessao: SessaoAdmin, raw: unknown, requestId: string, deps: UsuariosDeps = padrao, empresaSolicitada?: string | null) {
    const input = removerSchema.parse(raw);
    if (input.usuarioId === sessao.usuario_id)
        throw authError('Você não pode remover o próprio acesso.', 403);
    const resultado = await emTenant(sessao, empresaSolicitada, deps, async (tx, tenant) => {
        const empresaId = tenant.empresaComprovada;
        const atual = await membershipDaEmpresa(tx, empresaId, input.usuarioId);
        if (!atual || atual.status === 'REVOGADA')
            throw authError('Conta não encontrada nesta empresa.', 404);
        if (atual.status === 'ATIVA' && atual.papel === 'REPRESENTANTE_AUTORIZADO')
            await exigirOutraGestao(tx, empresaId, input.usuarioId);
        const avaliacao = await avaliarPerdaDeElegibilidade(tx, { usuarioId: input.usuarioId, modo: 'revogar-administrar', empresaId });
        if (avaliacao.recusado)
            return { tipo: 'recusado' as const };
        await marcarAtor(tx, sessao.usuario_id);
        await tx.query("UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid AND empresa_id = $2::uuid", [atual.membership_id, empresaId]);
        const festa = (await tx.query<{ id: string }>(
            `UPDATE festa_membership_capacidades SET revogado_por = $2, revogado_em = clock_timestamp(), motivo_revogacao = 'Acesso removido da empresa'
              WHERE membership_id = $1::uuid AND revogado_em IS NULL RETURNING id`,
            [atual.membership_id, sessao.usuario_id],
        )).rows;
        await revogarAssinaturaDaMembership(tx, empresaId, atual.membership_id, sessao.usuario_id, 'Acesso removido da empresa');
        const perfil = avaliacao.instalada
            ? await revogarConcessoesAtivasDoUsuario(tx, { usuarioId: input.usuarioId, operadorId: sessao.usuario_id, motivo: 'Acesso removido da empresa', empresaId })
            : [];
        const depois = membro({ ...atual, status: 'REVOGADA' });
        await deps.registrarAuditoria({
            atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'MEMBERSHIP_REMOVIDA',
            entidadeTipo: 'MEMBERSHIP', entidadeId: atual.membership_id,
            dadosAntes: { status: atual.status, empresaId }, dadosDepois: { status: 'REVOGADA', empresaId, capacidadesFesta: festa.length, concessoesPerfil: perfil.length },
            origem: 'ADMIN_USUARIOS', requestId,
        }, tx);
        return { tipo: 'ok' as const, conta: depois };
    });
    if (resultado.tipo === 'recusado')
        throw new ClienteServiceError('PERFIL_ULTIMA_ADMINISTRADORA', MENSAGEM_ULTIMA_ADMINISTRADORA, 409);
    return resultado.conta;
}

const assinaturaSchema = z.object({
    acao: z.literal('assinatura'),
    usuarioId: z.string().uuid().transform((value) => value.toLowerCase()),
    conceder: z.boolean(),
}).strict();

/**
 * 057 — assinar contratos em nome DESTA empresa (capability CONTRATO_ASSINAR_EMPRESA da membership).
 * Autoridade empresarial: a Gestão desta empresa concede ou retira, só para membership ATIVA de Gestão desta
 * empresa (a própria inclusive, para a empresa não ficar sem quem assine). Nunca toca o papel global nem outra
 * empresa, e não dá acesso a recurso de plataforma (tabela PDF, WhatsApp).
 */
export async function alterarAssinaturaNaEmpresa(sessao: SessaoAdmin, raw: unknown, requestId: string, deps: UsuariosDeps = padrao, empresaSolicitada?: string | null) {
    const input = assinaturaSchema.parse(raw);
    return emTenant(sessao, empresaSolicitada, deps, async (tx, tenant) => {
        const empresaId = tenant.empresaComprovada;
        const atual = await membershipDaEmpresa(tx, empresaId, input.usuarioId);
        if (!atual || atual.status !== 'ATIVA')
            throw authError('Conta não encontrada nesta empresa.', 404);
        if (input.conceder) {
            if (atual.papel !== 'REPRESENTANTE_AUTORIZADO')
                throw authError('Só a Gestão desta empresa pode assinar contratos. Altere o papel antes.', 409);
            if (atual.pode_assinar)
                return { ...membro(atual), reutilizado: true };
            await tx.query(
                `INSERT INTO empresa_membership_capacidades (empresa_id, membership_id, capacidade, concedido_por, motivo)
                 VALUES ($1::uuid, $2::uuid, 'CONTRATO_ASSINAR_EMPRESA', $3::uuid, 'Assinatura de contratos pela empresa concedida')
                 ON CONFLICT (membership_id, capacidade) WHERE revogado_em IS NULL DO NOTHING`,
                [empresaId, atual.membership_id, sessao.usuario_id],
            );
        } else {
            if (!atual.pode_assinar)
                return { ...membro(atual), reutilizado: true };
            await revogarAssinaturaDaMembership(tx, empresaId, atual.membership_id, sessao.usuario_id, 'Assinatura de contratos pela empresa retirada');
        }
        await deps.registrarAuditoria({
            atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: input.conceder ? 'CONTRATO_ASSINATURA_CONCEDIDA' : 'CONTRATO_ASSINATURA_REVOGADA',
            entidadeTipo: 'MEMBERSHIP', entidadeId: atual.membership_id,
            dadosAntes: { podeAssinar: Boolean(atual.pode_assinar), empresaId }, dadosDepois: { podeAssinar: input.conceder, empresaId },
            origem: 'ADMIN_USUARIOS', requestId,
        }, tx);
        return { ...membro({ ...atual, pode_assinar: input.conceder }), reutilizado: false };
    });
}

/**
 * PLATAFORMA — desativa a IDENTIDADE global (todas as empresas). Não é exposta a nenhuma rota de tenant
 * (decisão de produto 2026-09-29): só uma futura autoridade de Platform Admin poderá chamá-la.
 */
export async function desativarUsuarioAdministrativo(sessao: SessaoAdmin, raw: unknown, requestId: string, deps: UsuariosDeps = padrao) {
    exigirGestao(sessao);
    const input = desativarSchema.parse(raw);
    if (input.usuarioId === sessao.usuario_id)
        throw authError('Você não pode desativar a própria conta.', 403);
    const resultado = await deps.withTransaction(async (tx) => {
        const avaliacao = await avaliarPerdaDeElegibilidade(tx, { usuarioId: input.usuarioId, modo: 'desativar' });
        if (avaliacao.recusado) {
            await deps.registrarAuditoria({
                atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'PERFIL_REVOGACAO_RECUSADA',
                entidadeTipo: 'USUARIO_ADMINISTRATIVO', entidadeId: input.usuarioId,
                dadosDepois: { empresas: avaliacao.empresasBloqueadas, operacao: 'desativar' },
                justificativa: MENSAGEM_ULTIMA_ADMINISTRADORA, origem: 'ADMIN_USUARIOS', requestId,
            }, tx);
            return { tipo: 'recusado' as const };
        }
        const atual = (avaliacao.usuario
            ? { ...avaliacao.usuario, papel: avaliacao.usuario.papel as SessaoAdmin['papel'] }
            : null) ?? (await tx.query<{
            id: string;
            nome: string;
            email: string;
            papel: SessaoAdmin['papel'];
            ativo: boolean;
        }>('SELECT id,nome,email,papel,ativo FROM usuarios_administrativos WHERE id=$1 FOR UPDATE', [input.usuarioId])).rows[0];
        if (!atual)
            throw authError('Conta não encontrada.', 404);
        if (!atual.ativo)
            throw authError('Esta conta já está desativada.', 409);
        const atualizado = (await tx.query<{
            id: string;
            nome: string;
            email: string;
            papel: SessaoAdmin['papel'];
            ativo: boolean;
        }>('UPDATE usuarios_administrativos SET ativo=false WHERE id=$1 RETURNING id,nome,email,papel,ativo', [atual.id])).rows[0];
        await tx.query('UPDATE sessoes_administrativas SET revogado_em=clock_timestamp() WHERE usuario_id=$1 AND revogado_em IS NULL', [atual.id]);
        const revogadas = avaliacao.instalada
            ? await revogarConcessoesAtivasDoUsuario(tx, {
                usuarioId: atual.id,
                operadorId: sessao.usuario_id,
                motivo: 'Desativação da conta administrativa',
            })
            : [];
        const depois = conta(atualizado);
        await deps.registrarAuditoria({
            atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'ADMIN_DESATIVAR',
            entidadeTipo: 'USUARIO_ADMINISTRATIVO', entidadeId: atual.id,
            dadosAntes: conta(atual), dadosDepois: depois, origem: 'ADMIN_USUARIOS', requestId,
        }, tx);
        if (revogadas.length) {
            await deps.registrarAuditoria({
                atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'PERFIL_REVOGADO_NA_DESATIVACAO',
                entidadeTipo: 'USUARIO_ADMINISTRATIVO', entidadeId: atual.id,
                dadosDepois: { concessoes: revogadas }, origem: 'ADMIN_USUARIOS', requestId,
            }, tx);
        }
        return { tipo: 'ok' as const, conta: depois };
    });
    if (resultado.tipo === 'recusado')
        throw new ClienteServiceError('PERFIL_ULTIMA_ADMINISTRADORA', MENSAGEM_ULTIMA_ADMINISTRADORA, 409);
    return resultado.conta;
}
