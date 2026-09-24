import { z } from 'zod';
import type { DbExecutor } from '../db/contracts';
import { withTransaction as withTransactionPadrao } from '../db/postgres';
import { registrarAuditoria as registrarAuditoriaPadrao } from '../clientes/repositories/auditoria.repository';
import { authError, type SessaoAdmin } from './service.ts';
import { criarHashSenha as criarHashSenhaPadrao, senhaValida } from './senha.ts';
import { nomePapelSistema, papelDeNivel, type NivelSistema } from './papeis.ts';

export type UsuariosDeps = {
    withTransaction: typeof withTransactionPadrao;
    criarHashSenha: typeof criarHashSenhaPadrao;
    registrarAuditoria: typeof registrarAuditoriaPadrao;
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

export async function listarUsuariosAdministrativos(sessao: SessaoAdmin, tx: DbExecutor) {
    exigirGestao(sessao);
    const result = await tx.query<{
        id: string;
        nome: string;
        email: string;
        papel: SessaoAdmin['papel'];
        ativo: boolean;
    }>('SELECT id,nome,email,papel,ativo FROM usuarios_administrativos ORDER BY ativo DESC, nome, email');
    return { usuarioId: sessao.usuario_id, usuarios: result.rows.map(conta) };
}

export async function criarUsuarioAdministrativo(sessao: SessaoAdmin, raw: unknown, requestId: string, deps: UsuariosDeps = padrao) {
    exigirGestao(sessao);
    const input = criarSchema.parse(raw);
    if (input.senha !== input.confirmacao)
        throw authError('A senha e a confirmação não conferem.', 400);
    if (!senhaValida(input.senha))
        throw authError('A senha deve ter entre 8 e 128 caracteres.', 400);
    const email = input.email.trim().toLowerCase();
    const papel = papelDeNivel(input.nivel as NivelSistema);
    const senhaHash = await deps.criarHashSenha(input.senha);
    try {
        return await deps.withTransaction(async (tx) => {
            const duplicado = (await tx.query('SELECT id FROM usuarios_administrativos WHERE email=$1', [email])).rows[0];
            if (duplicado)
                throw authError('Já existe uma conta com este e-mail.', 409);
            const criado = (await tx.query<{
                id: string;
                nome: string;
                email: string;
                papel: SessaoAdmin['papel'];
                ativo: boolean;
            }>('INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel) VALUES($1,$2,$3,$4) RETURNING id,nome,email,papel,ativo',
                [email, input.nome, senhaHash, papel])).rows[0];
            const depois = conta(criado);
            await deps.registrarAuditoria({
                atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'ADMIN_CRIAR',
                entidadeTipo: 'USUARIO_ADMINISTRATIVO', entidadeId: criado.id, dadosDepois: depois,
                origem: 'ADMIN_USUARIOS', requestId,
            }, tx);
            return depois;
        });
    } catch (error) {
        if (isPgUniqueViolation(error))
            throw authError('Já existe uma conta com este e-mail.', 409);
        throw error;
    }
}

export async function desativarUsuarioAdministrativo(sessao: SessaoAdmin, raw: unknown, requestId: string, deps: UsuariosDeps = padrao) {
    exigirGestao(sessao);
    const input = desativarSchema.parse(raw);
    if (input.usuarioId === sessao.usuario_id)
        throw authError('Você não pode desativar a própria conta.', 403);
    return deps.withTransaction(async (tx) => {
        const atual = (await tx.query<{
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
        const depois = conta(atualizado);
        await deps.registrarAuditoria({
            atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'ADMIN_DESATIVAR',
            entidadeTipo: 'USUARIO_ADMINISTRATIVO', entidadeId: atual.id,
            dadosAntes: conta(atual), dadosDepois: depois, origem: 'ADMIN_USUARIOS', requestId,
        }, tx);
        return depois;
    });
}
