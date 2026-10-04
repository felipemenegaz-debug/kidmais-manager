import { z } from 'zod';
import type { DbExecutor } from '../db/contracts';
import { withTransaction as withTransactionPadrao } from '../db/postgres';
import { registrarAuditoria as registrarAuditoriaPadrao } from '../clientes/repositories/auditoria.repository';
import { consultarSessao, consumirLimite, criarSessaoAdministrativa, limparLimite, revogarSessoesDoUsuario } from '../autenticacao/service.ts';
import { conferirSenha as conferirSenhaPadrao, criarHashSenha as criarHashSenhaPadrao, senhaValida } from '../autenticacao/senha.ts';
import { erroAcesso } from './erros.ts';

/**
 * Troca da própria senha (área de perfil do usuário autenticado).
 *
 * Política de sessões (D4): a troca encerra TODAS as sessões da conta, inclusive de outros dispositivos, e emite uma
 * sessão nova só para o dispositivo que fez a troca. Mesmo sem o encerramento explícito, consultarSessao já recusa
 * sessão autenticada antes de senha_alterada_em.
 * Limite: 5 tentativas com a senha atual errada a cada 15 min por conta.
 * Auditoria: só o fato, o resultado e quantas sessões foram encerradas. Nunca senha, hash ou token.
 */
export type SenhaPropriaDeps = {
    withTransaction: typeof withTransactionPadrao;
    criarHashSenha: typeof criarHashSenhaPadrao;
    conferirSenha: typeof conferirSenhaPadrao;
    registrarAuditoria: typeof registrarAuditoriaPadrao;
    consultarSessao: typeof consultarSessao;
    consumirLimite: typeof consumirLimite;
    limparLimite: typeof limparLimite;
    criarSessaoAdministrativa: typeof criarSessaoAdministrativa;
    revogarSessoesDoUsuario: typeof revogarSessoesDoUsuario;
};

const padrao: SenhaPropriaDeps = {
    withTransaction: withTransactionPadrao,
    criarHashSenha: criarHashSenhaPadrao,
    conferirSenha: conferirSenhaPadrao,
    registrarAuditoria: registrarAuditoriaPadrao,
    consultarSessao,
    consumirLimite,
    limparLimite,
    criarSessaoAdministrativa,
    revogarSessoesDoUsuario,
};

export const trocaSenhaSchema = z.object({
    senhaAtual: z.string().min(1, 'Informe a senha atual.').max(512),
    novaSenha: z.string().max(512),
    confirmacao: z.string().max(512),
}).strict();

export const REGRA_TROCA = { namespace: 'troca-senha', janelaSegundos: 900, limite: 5 } as const;
export type ContextoRequisicao = { requestId: string; ip: string | null; userAgent: string | null };

/** Regras da nova senha que não dependem do banco (mesma política do projeto: 8–128 caracteres). */
export function validarNovaSenha(nova: string, confirmacao: string, atual?: string) {
    if (nova !== confirmacao)
        throw erroAcesso('SENHA_INVALIDA', 'A nova senha e a confirmação não conferem.', 400);
    if (!senhaValida(nova))
        throw erroAcesso('SENHA_INVALIDA', 'A nova senha deve ter entre 8 e 128 caracteres.', 400);
    if (atual !== undefined && nova === atual)
        throw erroAcesso('SENHA_INVALIDA', 'A nova senha precisa ser diferente da atual.', 400);
}

export async function trocarPropriaSenha(token: string, raw: unknown, ctx: ContextoRequisicao, deps: SenhaPropriaDeps = padrao) {
    const input = trocaSenhaSchema.parse(raw);
    validarNovaSenha(input.novaSenha, input.confirmacao, input.senhaAtual);
    // O hash novo (scrypt) só é calculado depois de sessão válida, limite e senha atual conferida.
    const resultado = await deps.withTransaction(async (tx: DbExecutor) => {
        const sessao = await deps.consultarSessao(token, tx, true);
        if (!await deps.consumirLimite(tx, 'IDENTIFICADOR', sessao.usuario_id, REGRA_TROCA))
            return { tipo: 'limite' as const };
        const atual = (await tx.query<{ senha_hash: string }>('SELECT senha_hash FROM usuarios_administrativos WHERE id=$1 AND ativo FOR UPDATE', [sessao.usuario_id])).rows[0];
        if (!atual || !await deps.conferirSenha(input.senhaAtual, atual.senha_hash)) {
            await deps.registrarAuditoria({
                atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'SENHA_TROCA_RECUSADA', entidadeTipo: 'USUARIO_ADMINISTRATIVO', entidadeId: sessao.usuario_id,
                dadosDepois: { resultado: 'RECUSADO', motivo: 'SENHA_ATUAL_INCORRETA' }, origem: 'PERFIL_SENHA', requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent,
            }, tx);
            return { tipo: 'senha-atual' as const };
        }
        const novoHash = await deps.criarHashSenha(input.novaSenha);
        await tx.query('UPDATE usuarios_administrativos SET senha_hash=$2, senha_alterada_em=clock_timestamp() WHERE id=$1', [sessao.usuario_id, novoHash]);
        const encerradas = await deps.revogarSessoesDoUsuario(tx, sessao.usuario_id);
        await deps.limparLimite(tx, 'IDENTIFICADOR', sessao.usuario_id, REGRA_TROCA.namespace);
        const nova = await deps.criarSessaoAdministrativa(tx, sessao.usuario_id, ctx.ip, ctx.userAgent);
        await deps.registrarAuditoria({
            atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'SENHA_ALTERADA', entidadeTipo: 'USUARIO_ADMINISTRATIVO', entidadeId: sessao.usuario_id,
            dadosDepois: { resultado: 'SUCESSO', sessoesEncerradas: encerradas, novaSessaoNesteDispositivo: true }, origem: 'PERFIL_SENHA',
            requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent,
        }, tx);
        return { tipo: 'ok' as const, sessao: nova, encerradas };
    });
    if (resultado.tipo === 'limite')
        throw erroAcesso('LIMITE_TENTATIVAS', 'Muitas tentativas. Aguarde 15 minutos e tente novamente.', 429);
    if (resultado.tipo === 'senha-atual')
        throw erroAcesso('SENHA_ATUAL_INCORRETA', 'A senha atual não confere.', 400);
    return { token: resultado.sessao.token, csrf: resultado.sessao.csrf, expires: resultado.sessao.expires, sessoesEncerradas: resultado.encerradas };
}
