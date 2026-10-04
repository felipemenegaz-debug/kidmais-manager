import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { DbExecutor } from '../db/contracts';
import { withTransaction as withTransactionPadrao } from '../db/postgres';
import { registrarAuditoria as registrarAuditoriaPadrao } from '../clientes/repositories/auditoria.repository';
import { consumirLimite } from '../autenticacao/service.ts';
import { conferirSenha as conferirSenhaPadrao, criarHashSenha as criarHashSenhaPadrao, hashToken } from '../autenticacao/senha.ts';
import { nomePapelSistema, type NivelSistema } from '../autenticacao/papeis.ts';
import { concederPerfilFesta, inserirIdentidadeNeutra, marcarAtor } from '../autenticacao/usuarios.ts';
import { erroAcesso, isAcessoServiceError } from './erros.ts';
import { criarEnviarEmail, linkComToken, mensagemConvite, type EnviarEmail } from './email.ts';
import { validarNovaSenha, type ContextoRequisicao } from './senha-propria.ts';
import { mascararEmail, nomeObrigatorio } from './validacao.ts';

/**
 * Convite de acesso a UMA empresa (063, convites_acesso).
 *
 * - Criado só pelo painel do desenvolvedor (provisionamento ou ficha da empresa). Não cria usuário nem vínculo.
 * - Token de 32 bytes; só o hash fica no banco; o link leva o token no fragmento (#). Validade de 7 dias.
 * - Reenvio gera token novo (o link anterior deixa de valer), com intervalo mínimo e limite de envios.
 * - Aceite: e-mail sem conta define nome e senha (identidade com papel global neutro); e-mail com conta confirma com
 *   a senha atual (limite compartilhado com o login). Cria/ativa só a membership da empresa do convite.
 * - O envio acontece depois do commit e o resultado real (enviado / não enviado e por quê) volta para a tela.
 */
export const VALIDADE_CONVITE_DIAS = 7;
export const INTERVALO_REENVIO_SEGUNDOS = 60;
export const MAXIMO_ENVIOS = 10;
const REGRA_ORIGEM_CONVITE = { namespace: 'convite', janelaSegundos: 900, limite: 30 } as const;

export type PapelConvite = 'ADMINISTRATIVO' | 'REPRESENTANTE_AUTORIZADO';
export type ConvitesDeps = {
    withTransaction: typeof withTransactionPadrao;
    registrarAuditoria: typeof registrarAuditoriaPadrao;
    criarHashSenha: typeof criarHashSenhaPadrao;
    conferirSenha: typeof conferirSenhaPadrao;
    enviarEmail: EnviarEmail;
    gerarToken: () => string;
};
export function convitesDepsPadrao(): ConvitesDeps {
    return {
        withTransaction: withTransactionPadrao,
        registrarAuditoria: registrarAuditoriaPadrao,
        criarHashSenha: criarHashSenhaPadrao,
        conferirSenha: conferirSenhaPadrao,
        enviarEmail: criarEnviarEmail(),
        gerarToken: () => randomBytes(32).toString('base64url'),
    };
}

export type ResultadoEnvioConvite = { enviado: true; destino: string } | { enviado: false; destino: string; motivo: string };

type LinhaConvite = {
    id: string; empresa_id: string; email: string; nome_sugerido: string | null; papel: PapelConvite; status: 'PENDENTE' | 'ACEITO' | 'CANCELADO';
    expira_em: string; expirado: boolean; envios: number; ultimo_envio_em: string | null; criado_por: string; criado_em: string;
    aceito_em: string | null; cancelado_em: string | null;
};

const COLUNAS = `c.id, c.empresa_id, c.email, c.nome_sugerido, c.papel, c.status, c.expira_em::text, (c.status = 'PENDENTE' AND c.expira_em <= clock_timestamp()) AS expirado,
  c.envios, c.ultimo_envio_em::text, c.criado_por, c.criado_em::text, c.aceito_em::text, c.cancelado_em::text`;

export type ConviteResumo = {
    id: string; email: string; nomeSugerido: string | null; papel: PapelConvite; nivel: string;
    situacao: 'PENDENTE' | 'EXPIRADO' | 'ACEITO' | 'CANCELADO'; expiraEm: string; envios: number; ultimoEnvioEm: string | null;
    criadoEm: string; aceitoEm: string | null; canceladoEm: string | null;
};

export function resumoConvite(c: LinhaConvite): ConviteResumo {
    return {
        id: c.id, email: c.email, nomeSugerido: c.nome_sugerido, papel: c.papel, nivel: nomePapelSistema(c.papel),
        situacao: c.status === 'PENDENTE' && c.expirado ? 'EXPIRADO' : c.status, expiraEm: c.expira_em, envios: c.envios,
        ultimoEnvioEm: c.ultimo_envio_em, criadoEm: c.criado_em, aceitoEm: c.aceito_em, canceladoEm: c.cancelado_em,
    };
}

export async function listarConvitesDaEmpresa(tx: DbExecutor, empresaId: string) {
    const linhas = (await tx.query<LinhaConvite>(`SELECT ${COLUNAS} FROM convites_acesso c WHERE c.empresa_id = $1::uuid ORDER BY c.criado_em DESC LIMIT 200`, [empresaId])).rows;
    return linhas.map(resumoConvite);
}

/**
 * Cria o convite dentro da transação do chamador (que já provou a autoridade de desenvolvedor e travou a empresa).
 * Recusa quando a pessoa já tem vínculo nesta empresa (ativo, desativado ou removido) ou já há convite pendente válido.
 * Convite pendente vencido do mesmo e-mail é cancelado e substituído.
 */
export async function criarConviteNaTransacao(tx: DbExecutor, deps: Pick<ConvitesDeps, 'gerarToken'>, input: {
    empresaId: string; email: string; nomeSugerido: string | null; papel: PapelConvite; criadoPor: string;
}) {
    const empresa = (await tx.query<{ status: string }>('SELECT status FROM empresas WHERE id = $1::uuid FOR UPDATE', [input.empresaId])).rows[0];
    if (!empresa)
        throw erroAcesso('NAO_ENCONTRADO', 'Empresa não encontrada.', 404);
    if (empresa.status !== 'ATIVA')
        throw erroAcesso('CONFLITO', 'Só uma empresa ativa recebe convites. Reative a empresa antes.', 409);
    const vinculo = (await tx.query<{ status: string }>(
        `SELECT m.status FROM memberships m JOIN usuarios_administrativos u ON u.id = m.usuario_id
          WHERE m.empresa_id = $1::uuid AND u.email = $2 FOR UPDATE OF m`, [input.empresaId, input.email])).rows[0];
    if (vinculo?.status === 'ATIVA')
        throw erroAcesso('CONFLITO', 'Esta pessoa já tem acesso ativo a esta empresa.', 409);
    if (vinculo?.status === 'SUSPENSA')
        throw erroAcesso('CONFLITO', 'O vínculo desta pessoa com a empresa está desativado. Reative o vínculo em vez de convidar.', 409);
    if (vinculo?.status === 'REVOGADA')
        throw erroAcesso('CONFLITO', 'O acesso desta pessoa a esta empresa foi removido definitivamente e não pode ser reaberto.', 409);
    const pendente = (await tx.query<LinhaConvite>(`SELECT ${COLUNAS} FROM convites_acesso c WHERE c.empresa_id = $1::uuid AND c.email = $2 AND c.status = 'PENDENTE' FOR UPDATE`, [input.empresaId, input.email])).rows[0];
    if (pendente && !pendente.expirado)
        throw erroAcesso('CONFLITO', 'Já existe convite pendente para este e-mail nesta empresa. Use "Reenviar".', 409, { conviteId: pendente.id });
    if (pendente)
        await tx.query("UPDATE convites_acesso SET status = 'CANCELADO', cancelado_por = $2 WHERE id = $1", [pendente.id, input.criadoPor]);
    const token = deps.gerarToken();
    const criado = (await tx.query<{ id: string; expira_em: string }>(
        `INSERT INTO convites_acesso (empresa_id, email, nome_sugerido, papel, token_hash, expira_em, criado_por)
         VALUES ($1::uuid, $2, $3, $4, $5, clock_timestamp() + make_interval(days => $6::int), $7) RETURNING id, expira_em::text`,
        [input.empresaId, input.email, input.nomeSugerido, input.papel, hashToken(token), VALIDADE_CONVITE_DIAS, input.criadoPor])).rows[0];
    return { id: criado.id, token, expiraEm: criado.expira_em, substituiu: pendente?.id ?? null };
}

/** Gera token novo para um convite pendente desta empresa (vencido ou não), respeitando intervalo e limite de envios. */
export async function renovarConviteNaTransacao(tx: DbExecutor, deps: Pick<ConvitesDeps, 'gerarToken'>, empresaId: string, conviteId: string) {
    const c = (await tx.query<LinhaConvite & { segundos_desde_envio: number | null }>(
        `SELECT ${COLUNAS}, extract(epoch FROM clock_timestamp() - c.ultimo_envio_em)::int AS segundos_desde_envio
           FROM convites_acesso c WHERE c.id = $1::uuid AND c.empresa_id = $2::uuid FOR UPDATE`, [conviteId, empresaId])).rows[0];
    if (!c)
        throw erroAcesso('NAO_ENCONTRADO', 'Convite não encontrado nesta empresa.', 404);
    if (c.status !== 'PENDENTE')
        throw erroAcesso('CONFLITO', c.status === 'ACEITO' ? 'Este convite já foi aceito.' : 'Este convite foi cancelado. Crie um novo.', 409);
    if (c.segundos_desde_envio !== null && c.segundos_desde_envio < INTERVALO_REENVIO_SEGUNDOS)
        throw erroAcesso('LIMITE_TENTATIVAS', `Aguarde ${INTERVALO_REENVIO_SEGUNDOS - c.segundos_desde_envio} segundos para reenviar.`, 429);
    if (c.envios >= MAXIMO_ENVIOS)
        throw erroAcesso('LIMITE_TENTATIVAS', 'Este convite atingiu o limite de envios. Cancele e crie um novo.', 429);
    const token = deps.gerarToken();
    const renovado = (await tx.query<{ expira_em: string }>(
        `UPDATE convites_acesso SET token_hash = $2, expira_em = clock_timestamp() + make_interval(days => $3::int) WHERE id = $1 RETURNING expira_em::text`,
        [c.id, hashToken(token), VALIDADE_CONVITE_DIAS])).rows[0];
    return { id: c.id, email: c.email, papel: c.papel, token, expiraEm: renovado.expira_em };
}

export async function cancelarConviteNaTransacao(tx: DbExecutor, empresaId: string, conviteId: string, atorId: string) {
    const c = (await tx.query<LinhaConvite>(`SELECT ${COLUNAS} FROM convites_acesso c WHERE c.id = $1::uuid AND c.empresa_id = $2::uuid FOR UPDATE`, [conviteId, empresaId])).rows[0];
    if (!c)
        throw erroAcesso('NAO_ENCONTRADO', 'Convite não encontrado nesta empresa.', 404);
    if (c.status !== 'PENDENTE')
        throw erroAcesso('CONFLITO', c.status === 'ACEITO' ? 'Este convite já foi aceito; desative o vínculo se necessário.' : 'Este convite já está cancelado.', 409);
    await tx.query("UPDATE convites_acesso SET status = 'CANCELADO', cancelado_por = $2 WHERE id = $1", [c.id, atorId]);
    return { id: c.id, email: c.email, papel: c.papel };
}

/**
 * Envia o e-mail de um convite já gravado e, só se o provedor aceitar, conta o envio.
 * Nunca lança: devolve o resultado real para a tela e para a auditoria.
 */
export async function enviarConvite(deps: Pick<ConvitesDeps, 'withTransaction' | 'enviarEmail'>, input: { conviteId: string; email: string; empresaNome: string; papel: PapelConvite; token: string }): Promise<ResultadoEnvioConvite> {
    const destino = mascararEmail(input.email);
    try {
        const mensagem = mensagemConvite({ para: input.email, empresa: input.empresaNome, papel: nomePapelSistema(input.papel), link: linkComToken('/acesso/convite', input.token), validadeDias: VALIDADE_CONVITE_DIAS });
        await deps.enviarEmail(mensagem);
    }
    catch (error) {
        const motivo = isAcessoServiceError(error) ? error.message : 'Falha inesperada no envio. Nada foi enviado.';
        return { enviado: false, destino, motivo };
    }
    await deps.withTransaction((tx) => tx.query("UPDATE convites_acesso SET envios = envios + 1, ultimo_envio_em = clock_timestamp() WHERE id = $1 AND status = 'PENDENTE'", [input.conviteId]));
    return { enviado: true, destino };
}

// ---------------------------------------------------------------------------------------------------------------
// Fluxo público (quem recebeu o link)
// ---------------------------------------------------------------------------------------------------------------

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export type ConsultaConvite =
    | { situacao: 'INVALIDO' }
    | { situacao: 'PENDENTE' | 'EXPIRADO' | 'ACEITO' | 'CANCELADO' | 'EMPRESA_INDISPONIVEL'; empresa: string; email: string; nivel: string; contaExistente: boolean };

/** Consulta para a tela de aceite. Só quem tem o token vê empresa e e-mail do convite. */
export async function consultarConvite(raw: unknown, ctx: ContextoRequisicao, deps: Pick<ConvitesDeps, 'withTransaction'> = convitesDepsPadrao()): Promise<ConsultaConvite> {
    const token = tokenSchema.safeParse((raw as { token?: unknown } | null)?.token);
    return deps.withTransaction(async (tx) => {
        if (!await consumirLimite(tx, 'ORIGEM', ctx.ip ?? 'ORIGEM_NAO_VERIFICADA', REGRA_ORIGEM_CONVITE))
            throw erroAcesso('LIMITE_TENTATIVAS', 'Muitas tentativas. Aguarde alguns minutos.', 429);
        if (!token.success)
            return { situacao: 'INVALIDO' as const };
        const c = (await tx.query<LinhaConvite & { empresa_nome: string; empresa_status: string; conta: boolean }>(
            `SELECT ${COLUNAS}, e.nome AS empresa_nome, e.status AS empresa_status,
                    EXISTS (SELECT 1 FROM usuarios_administrativos u WHERE u.email = c.email) AS conta
               FROM convites_acesso c JOIN empresas e ON e.id = c.empresa_id WHERE c.token_hash = $1`, [hashToken(token.data)])).rows[0];
        if (!c)
            return { situacao: 'INVALIDO' as const };
        const situacao = c.status === 'PENDENTE' && c.empresa_status !== 'ATIVA' ? 'EMPRESA_INDISPONIVEL' as const : resumoConvite(c).situacao;
        return { situacao, empresa: c.empresa_nome, email: c.email, nivel: nomePapelSistema(c.papel), contaExistente: c.conta };
    });
}

const aceiteSchema = z.object({
    token: tokenSchema,
    nome: nomeObrigatorio(2, 120).optional(),
    senha: z.string().max(512),
    confirmacao: z.string().max(512).optional(),
}).strict();

const RECUSA_GENERICA = 'Não foi possível aceitar o convite com estes dados.';

export async function aceitarConvite(raw: unknown, ctx: ContextoRequisicao, deps: ConvitesDeps = convitesDepsPadrao()) {
    const parsed = aceiteSchema.safeParse(raw);
    if (!parsed.success)
        throw erroAcesso('DADOS_INVALIDOS', 'Dados inválidos.', 400);
    const input = parsed.data;
    // Conta nova: só a validação barata aqui. O hash (scrypt) é calculado depois do limite por origem e só para
    // convite válido de e-mail sem conta — token falso ou excesso de tentativas nunca custa um scrypt.
    if (input.confirmacao !== undefined)
        validarNovaSenha(input.senha, input.confirmacao);
    const resultado = await deps.withTransaction(async (tx) => {
        if (!await consumirLimite(tx, 'ORIGEM', ctx.ip ?? 'ORIGEM_NAO_VERIFICADA', REGRA_ORIGEM_CONVITE))
            return { tipo: 'limite' as const };
        const c = (await tx.query<LinhaConvite>(`SELECT ${COLUNAS} FROM convites_acesso c WHERE c.token_hash = $1 FOR UPDATE`, [hashToken(input.token)])).rows[0];
        if (!c || c.status !== 'PENDENTE' || c.expirado)
            return { tipo: 'link' as const };
        const empresa = (await tx.query<{ nome: string; status: string }>('SELECT nome, status FROM empresas WHERE id = $1 FOR SHARE', [c.empresa_id])).rows[0];
        if (empresa?.status !== 'ATIVA')
            return { tipo: 'empresa' as const };
        const conta = (await tx.query<{ id: string; senha_hash: string; ativo: boolean }>('SELECT id, senha_hash, ativo FROM usuarios_administrativos WHERE email = $1 FOR UPDATE', [c.email])).rows[0];
        let usuarioId: string;
        let contaNova = false;
        if (conta) {
            // Conta existente: prova de posse pela senha atual; a janela é a MESMA do login (5 por 15 min por e-mail).
            if (!await consumirLimite(tx, 'IDENTIFICADOR', c.email, { janelaSegundos: 900, limite: 5 }))
                return { tipo: 'limite' as const };
            if (!await deps.conferirSenha(input.senha, conta.senha_hash) || !conta.ativo) {
                await deps.registrarAuditoria({ atorTipo: 'SISTEMA', acao: 'CONVITE_ACEITE_RECUSADO', entidadeTipo: 'CONVITE_ACESSO', entidadeId: c.id,
                    dadosDepois: { empresaId: c.empresa_id, resultado: 'RECUSADO', motivo: 'CREDENCIAL' }, origem: 'CONVITE_PUBLICO', requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent }, tx);
                return { tipo: 'credencial' as const };
            }
            usuarioId = conta.id;
        }
        else {
            if (input.confirmacao === undefined || !input.nome)
                return { tipo: 'conta-nova-incompleta' as const };
            usuarioId = await inserirIdentidadeNeutra(tx, c.email, { nome: input.nome }, await deps.criarHashSenha(input.senha));
            contaNova = true;
        }
        await marcarAtor(tx, usuarioId);
        const vinculo = (await tx.query<{ id: string; status: string }>('SELECT id, status FROM memberships WHERE empresa_id = $1 AND usuario_id = $2 FOR UPDATE', [c.empresa_id, usuarioId])).rows[0];
        if (vinculo && vinculo.status !== 'PENDENTE' && vinculo.status !== 'ATIVA')
            return { tipo: 'vinculo' as const, status: vinculo.status };
        let membershipId = vinculo?.id;
        if (!membershipId) {
            membershipId = (await tx.query<{ id: string }>(
                `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), $3) RETURNING id`,
                [c.empresa_id, usuarioId, c.papel])).rows[0].id;
        }
        if (vinculo?.status !== 'ATIVA') {
            await tx.query('UPDATE memberships SET papel = $3 WHERE id = $1 AND empresa_id = $2', [membershipId, c.empresa_id, c.papel]);
            await tx.query("UPDATE memberships SET status = 'ATIVA' WHERE id = $1 AND empresa_id = $2", [membershipId, c.empresa_id]);
            await concederPerfilFesta(tx, c.empresa_id, membershipId, (c.papel === 'REPRESENTANTE_AUTORIZADO' ? 'GESTAO' : 'EQUIPE') as NivelSistema, c.criado_por);
        }
        await tx.query("UPDATE convites_acesso SET status = 'ACEITO', aceito_usuario_id = $2, membership_id = $3 WHERE id = $1", [c.id, usuarioId, membershipId]);
        const implantacao = (await tx.query<{ implantacao: string }>(
            `UPDATE plataforma_empresas_cadastro SET implantacao = 'EM_CONFIGURACAO', atualizado_por = $2
              WHERE empresa_id = $1 AND implantacao = 'AGUARDANDO_PRIMEIRO_ACESSO' RETURNING implantacao`, [c.empresa_id, usuarioId])).rows[0];
        await deps.registrarAuditoria({
            atorTipo: 'USUARIO', usuarioId, acao: 'CONVITE_ACEITO', entidadeTipo: 'CONVITE_ACESSO', entidadeId: c.id,
            dadosDepois: { empresaId: c.empresa_id, membershipId, papel: c.papel, contaNova, vinculoJaAtivo: vinculo?.status === 'ATIVA', implantacao: implantacao?.implantacao ?? null, resultado: 'SUCESSO' },
            origem: 'CONVITE_PUBLICO', requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent,
        }, tx);
        return { tipo: 'ok' as const, empresa: empresa.nome, contaNova };
    });
    switch (resultado.tipo) {
        case 'ok': return { aceito: true as const, empresa: resultado.empresa, contaNova: resultado.contaNova };
        case 'limite': throw erroAcesso('LIMITE_TENTATIVAS', 'Muitas tentativas. Aguarde 15 minutos e tente novamente.', 429);
        case 'link': throw erroAcesso('LINK_INVALIDO', 'Este convite é inválido, já foi usado ou expirou. Peça um novo convite.', 410);
        case 'empresa': throw erroAcesso('CONFLITO', 'O acesso a esta empresa está indisponível no momento.', 409);
        case 'conta-nova-incompleta': throw erroAcesso('DADOS_INVALIDOS', 'Informe seu nome, a senha e a confirmação para criar o acesso.', 400);
        case 'vinculo': throw erroAcesso('CONFLITO', resultado.status === 'SUSPENSA' ? 'Seu acesso a esta empresa está desativado. Fale com o responsável.' : 'Seu acesso a esta empresa foi removido e não pode ser reaberto por convite.', 409);
        default: throw erroAcesso('DADOS_INVALIDOS', RECUSA_GENERICA, 400);
    }
}
