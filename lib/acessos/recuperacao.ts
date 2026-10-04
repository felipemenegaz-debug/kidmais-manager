import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { DbExecutor } from '../db/contracts';
import { withTransaction as withTransactionPadrao } from '../db/postgres';
import { registrarAuditoria as registrarAuditoriaPadrao } from '../clientes/repositories/auditoria.repository';
import { consumirLimite, revogarSessoesDoUsuario } from '../autenticacao/service.ts';
import { criarHashSenha as criarHashSenhaPadrao, hashToken } from '../autenticacao/senha.ts';
import { erroAcesso, isAcessoServiceError } from './erros.ts';
import { criarEnviarEmail, linkComToken, mensagemRecuperacao, type EnviarEmail } from './email.ts';
import { validarNovaSenha, type ContextoRequisicao } from './senha-propria.ts';
import { emailObrigatorio, mascararEmail } from './validacao.ts';

/**
 * Recuperação de senha (063, recuperacoes_senha).
 *
 * - Token de 32 bytes, uso único, 30 minutos. Só o hash fica no banco; o link leva o token no fragmento (#).
 * - Um pedido aberto por conta: pedido novo invalida o anterior. Intervalo mínimo de 2 minutos entre pedidos.
 * - Pedido público: a resposta é sempre a mesma, exista ou não a conta (o processamento roda depois da resposta).
 *   Limites: 10 por IP e 3 por e-mail a cada hora.
 * - Pedido pelo painel: só dispara o e-mail. O desenvolvedor não vê link, token nem senha.
 * - Redefinição: limite por IP; sucesso troca o hash, encerra todas as sessões e consome o token.
 */
export const VALIDADE_RECUPERACAO_MINUTOS = 30;
export const INTERVALO_PEDIDOS_SEGUNDOS = 120;
const REGRA_PEDIDO_IP = { namespace: 'recuperacao', janelaSegundos: 3600, limite: 10 } as const;
const REGRA_PEDIDO_EMAIL = { namespace: 'recuperacao', janelaSegundos: 3600, limite: 3 } as const;
const REGRA_REDEFINIR_IP = { namespace: 'redefinir', janelaSegundos: 900, limite: 10 } as const;

export type RecuperacaoDeps = {
    withTransaction: typeof withTransactionPadrao;
    registrarAuditoria: typeof registrarAuditoriaPadrao;
    criarHashSenha: typeof criarHashSenhaPadrao;
    enviarEmail: EnviarEmail;
    gerarToken: () => string;
};
export function recuperacaoDepsPadrao(): RecuperacaoDeps {
    return {
        withTransaction: withTransactionPadrao,
        registrarAuditoria: registrarAuditoriaPadrao,
        criarHashSenha: criarHashSenhaPadrao,
        enviarEmail: criarEnviarEmail(),
        gerarToken: () => randomBytes(32).toString('base64url'),
    };
}

export const MENSAGEM_PEDIDO_PUBLICO = 'Se houver uma conta ativa com este e-mail, enviaremos um link para definir uma nova senha. Confira sua caixa de entrada nos próximos minutos.';

type Conta = { id: string; email: string };

/**
 * Abre um pedido para a conta (invalidando o anterior) dentro da transação do chamador.
 * Devolve null quando o último pedido é recente demais (proteção contra repetição).
 */
export async function abrirPedidoNaTransacao(tx: DbExecutor, deps: Pick<RecuperacaoDeps, 'gerarToken'>, conta: Conta, origem: 'PUBLICA' | 'PAINEL', solicitadoPor: string | null) {
    const recente = (await tx.query<{ segundos: number }>(
        `SELECT extract(epoch FROM clock_timestamp() - max(criado_em))::int AS segundos FROM recuperacoes_senha WHERE usuario_id = $1`, [conta.id])).rows[0];
    if (recente?.segundos !== null && recente?.segundos !== undefined && recente.segundos < INTERVALO_PEDIDOS_SEGUNDOS)
        return { tipo: 'recente' as const, aguardar: INTERVALO_PEDIDOS_SEGUNDOS - recente.segundos };
    const invalidados = (await tx.query<{ id: string }>(
        'UPDATE recuperacoes_senha SET invalidado_em = clock_timestamp() WHERE usuario_id = $1 AND usado_em IS NULL AND invalidado_em IS NULL RETURNING id', [conta.id])).rows.length;
    const token = deps.gerarToken();
    const pedido = (await tx.query<{ id: string }>(
        `INSERT INTO recuperacoes_senha (usuario_id, token_hash, origem, solicitado_por, expira_em)
         VALUES ($1, $2, $3, $4, clock_timestamp() + make_interval(mins => $5::int)) RETURNING id`,
        [conta.id, hashToken(token), origem, solicitadoPor, VALIDADE_RECUPERACAO_MINUTOS])).rows[0];
    return { tipo: 'ok' as const, pedidoId: pedido.id, token, invalidados };
}

/** Envia o e-mail; se falhar, invalida o pedido (nenhum link fica valendo sem ter sido entregue). Nunca lança. */
export async function enviarPedido(deps: Pick<RecuperacaoDeps, 'withTransaction' | 'enviarEmail'>, pedido: { pedidoId: string; token: string }, email: string) {
    try {
        await deps.enviarEmail(mensagemRecuperacao({ para: email, link: linkComToken('/acesso/redefinir', pedido.token), validadeMinutos: VALIDADE_RECUPERACAO_MINUTOS }));
        return { enviado: true as const, destino: mascararEmail(email) };
    }
    catch (error) {
        await deps.withTransaction((tx) => tx.query('UPDATE recuperacoes_senha SET invalidado_em = clock_timestamp() WHERE id = $1 AND usado_em IS NULL AND invalidado_em IS NULL', [pedido.pedidoId]));
        return { enviado: false as const, destino: mascararEmail(email), motivo: isAcessoServiceError(error) ? error.message : 'Falha inesperada no envio. Nada foi enviado.' };
    }
}

const pedidoSchema = z.object({ email: emailObrigatorio }).strict();

/** Valida o corpo do pedido público; o resto acontece em `processarPedidoPublico`, depois da resposta. */
export function validarPedidoPublico(raw: unknown) {
    const r = pedidoSchema.safeParse(raw);
    if (!r.success)
        throw erroAcesso('DADOS_INVALIDOS', 'Informe um e-mail válido.', 400);
    return r.data;
}

/** Processamento do pedido público. Não devolve nada que distinga conta existente de inexistente. */
export async function processarPedidoPublico(input: { email: string }, ctx: ContextoRequisicao, deps: RecuperacaoDeps = recuperacaoDepsPadrao()) {
    const aberto = await deps.withTransaction(async (tx) => {
        const ipOk = await consumirLimite(tx, 'ORIGEM', ctx.ip ?? 'ORIGEM_NAO_VERIFICADA', REGRA_PEDIDO_IP);
        const emailOk = await consumirLimite(tx, 'IDENTIFICADOR', input.email, REGRA_PEDIDO_EMAIL);
        const conta = (await tx.query<Conta>('SELECT id, email FROM usuarios_administrativos WHERE email = $1 AND ativo FOR UPDATE', [input.email])).rows[0];
        let resultado: string;
        let pedido: { pedidoId: string; token: string } | null = null;
        if (!ipOk || !emailOk)
            resultado = 'LIMITE';
        else if (!conta)
            resultado = 'SEM_CONTA_ATIVA';
        else {
            const r = await abrirPedidoNaTransacao(tx, deps, conta, 'PUBLICA', null);
            resultado = r.tipo === 'ok' ? 'ABERTO' : 'RECENTE';
            if (r.tipo === 'ok')
                pedido = { pedidoId: r.pedidoId, token: r.token };
        }
        // Sem e-mail na auditoria: a entidade é a conta quando existe; senão, a própria requisição.
        await deps.registrarAuditoria({
            atorTipo: 'SISTEMA', usuarioId: null, acao: 'RECUPERACAO_SOLICITADA', entidadeTipo: conta ? 'USUARIO_ADMINISTRATIVO' : 'RECUPERACAO_SENHA',
            entidadeId: conta?.id ?? ctx.requestId, dadosDepois: { origem: 'PUBLICA', resultado, pedidoId: pedido?.pedidoId ?? null },
            origem: 'RECUPERACAO_PUBLICA', requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent,
        }, tx);
        return pedido && conta ? { pedido, conta } : null;
    });
    if (!aberto)
        return;
    const envio = await enviarPedido(deps, aberto.pedido, aberto.conta.email);
    if (!envio.enviado) {
        await deps.registrarAuditoria({
            atorTipo: 'SISTEMA', acao: 'RECUPERACAO_ENVIO_FALHOU', entidadeTipo: 'USUARIO_ADMINISTRATIVO', entidadeId: aberto.conta.id,
            dadosDepois: { origem: 'PUBLICA', pedidoId: aberto.pedido.pedidoId, resultado: 'NAO_ENVIADO' }, origem: 'RECUPERACAO_PUBLICA', requestId: ctx.requestId,
        });
    }
}

const redefinirSchema = z.object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    novaSenha: z.string().max(512),
    confirmacao: z.string().max(512),
}).strict();

export async function redefinirSenhaComToken(raw: unknown, ctx: ContextoRequisicao, deps: RecuperacaoDeps = recuperacaoDepsPadrao()) {
    const parsed = redefinirSchema.safeParse(raw);
    if (!parsed.success)
        throw erroAcesso('LINK_INVALIDO', 'Este link é inválido ou expirou. Peça uma nova recuperação.', 410);
    // Só regras baratas antes do limite. O scrypt (N=131072, ~128 MB) roda DEPOIS do limite por IP e só para token
    // válido e aberto: requisições com token falso ou acima do limite nunca chegam a calcular hash.
    validarNovaSenha(parsed.data.novaSenha, parsed.data.confirmacao);
    const resultado = await deps.withTransaction(async (tx) => {
        if (!await consumirLimite(tx, 'ORIGEM', ctx.ip ?? 'ORIGEM_NAO_VERIFICADA', REGRA_REDEFINIR_IP))
            return { tipo: 'limite' as const };
        const pedido = (await tx.query<{ id: string; usuario_id: string; origem: string }>(
            `SELECT r.id, r.usuario_id, r.origem FROM recuperacoes_senha r JOIN usuarios_administrativos u ON u.id = r.usuario_id
              WHERE r.token_hash = $1 AND r.usado_em IS NULL AND r.invalidado_em IS NULL AND r.expira_em > clock_timestamp() AND u.ativo
              FOR UPDATE OF r, u`, [hashToken(parsed.data.token)])).rows[0];
        if (!pedido)
            return { tipo: 'link' as const };
        const novoHash = await deps.criarHashSenha(parsed.data.novaSenha);
        await tx.query('UPDATE usuarios_administrativos SET senha_hash = $2, senha_alterada_em = clock_timestamp() WHERE id = $1', [pedido.usuario_id, novoHash]);
        await tx.query('UPDATE recuperacoes_senha SET usado_em = clock_timestamp() WHERE id = $1', [pedido.id]);
        const encerradas = await revogarSessoesDoUsuario(tx, pedido.usuario_id);
        await deps.registrarAuditoria({
            atorTipo: 'USUARIO', usuarioId: pedido.usuario_id, acao: 'SENHA_REDEFINIDA', entidadeTipo: 'USUARIO_ADMINISTRATIVO', entidadeId: pedido.usuario_id,
            dadosDepois: { pedidoId: pedido.id, origemPedido: pedido.origem, sessoesEncerradas: encerradas, resultado: 'SUCESSO' },
            origem: 'RECUPERACAO_PUBLICA', requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent,
        }, tx);
        return { tipo: 'ok' as const, encerradas };
    });
    if (resultado.tipo === 'limite')
        throw erroAcesso('LIMITE_TENTATIVAS', 'Muitas tentativas. Aguarde alguns minutos.', 429);
    if (resultado.tipo === 'link')
        throw erroAcesso('LINK_INVALIDO', 'Este link é inválido, já foi usado ou expirou. Peça uma nova recuperação.', 410);
    return { redefinida: true as const, sessoesEncerradas: resultado.encerradas };
}
