import { z } from 'zod';
import type { DbExecutor } from '../db/contracts';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import { authError } from '../autenticacao/service.ts';
import { marcarAtor } from '../autenticacao/usuarios.ts';
import { executarNoTenant, type TenantComprovado } from '../saas/provar-tenant.ts';
import {
    cancelarConviteNaTransacao, convitesDepsPadrao, criarConviteNaTransacao, enviarConvite, listarConvitesDaEmpresa, renovarConviteNaTransacao,
    type ConvitesDeps, type ConviteResumo, type ResultadoEnvioConvite,
} from './convites.ts';
import type { ContextoRequisicao } from './senha-propria.ts';
import { emailObrigatorio, textoOpcional } from './validacao.ts';

/**
 * Convites feitos pela Gestão DA PRÓPRIA EMPRESA (venda por assinatura, E1).
 *
 * Mesmo convite do painel do desenvolvedor (063, convites_acesso), com outra autoridade: em vez da concessão de
 * desenvolvedor, a transação prova o tenant da sessão (provarTenant) e exige Gestão NESTA empresa. O empresaId
 * nunca vem do corpo; só da empresa comprovada. Quem já tem conta só entra pelo aceite com a própria senha — a
 * empresa não vincula identidade alheia nem define senha de terceiros.
 *
 * Nada aqui diz se o e-mail já tem conta no Kidmais (F2): as recusas falam só do vínculo e dos convites desta empresa.
 */
const ORIGEM = 'ADMIN_USUARIOS';

export type ConvitesEmpresaDeps = Pick<ConvitesDeps, 'withTransaction' | 'registrarAuditoria' | 'enviarEmail' | 'gerarToken'>;

const convidarSchema = z.object({
    acao: z.literal('convidar'),
    email: emailObrigatorio,
    nome: textoOpcional(120),
    nivel: z.enum(['GESTAO', 'EQUIPE']),
}).strict();

const conviteSchema = z.object({
    acao: z.enum(['reenviar-convite', 'cancelar-convite']),
    conviteId: z.string().uuid().transform((v) => v.toLowerCase()),
}).strict();

function exigirGestao(tenant: TenantComprovado) {
    if (tenant.papelAtual !== 'REPRESENTANTE_AUTORIZADO')
        throw authError('Somente a Gestão pode administrar usuários.', 403);
}

function naGestao<T>(sessao: SessaoAdmin, empresaSolicitada: string | null | undefined, deps: ConvitesEmpresaDeps, trabalho: (tx: DbExecutor, tenant: TenantComprovado) => Promise<T>) {
    return deps.withTransaction((tx) => executarNoTenant(tx, sessao, empresaSolicitada, async (txTenant, tenant) => {
        exigirGestao(tenant);
        await marcarAtor(txTenant, sessao.usuario_id);
        return trabalho(txTenant, tenant);
    }));
}

async function nomeDaEmpresa(tx: DbExecutor, empresaId: string) {
    return (await tx.query<{ nome: string }>('SELECT nome FROM empresas WHERE id = $1::uuid', [empresaId])).rows[0]?.nome ?? '';
}

/** Resultado real do envio, auditado fora da transação do convite (o convite já existe mesmo se o e-mail falhar). */
async function auditarEnvio(deps: ConvitesEmpresaDeps, sessao: SessaoAdmin, ctx: ContextoRequisicao, empresaId: string, conviteId: string, envio: ResultadoEnvioConvite) {
    await deps.registrarAuditoria({
        atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: envio.enviado ? 'CONVITE_ENVIADO' : 'CONVITE_ENVIO_FALHOU',
        entidadeTipo: 'CONVITE_ACESSO', entidadeId: conviteId,
        dadosDepois: { empresaId, destino: envio.destino, motivo: envio.enviado ? null : envio.motivo, resultado: envio.enviado ? 'SUCESSO' : 'FALHA' },
        origem: ORIGEM, requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent,
    });
}

export async function listarConvitesNaEmpresa(sessao: SessaoAdmin, empresaSolicitada: string | null | undefined, deps: ConvitesEmpresaDeps = convitesDepsPadrao()): Promise<ConviteResumo[]> {
    return naGestao(sessao, empresaSolicitada, deps, (tx, tenant) => listarConvitesDaEmpresa(tx, tenant.empresaComprovada));
}

export async function convidarNaEmpresa(sessao: SessaoAdmin, raw: unknown, ctx: ContextoRequisicao, deps: ConvitesEmpresaDeps = convitesDepsPadrao(), empresaSolicitada?: string | null) {
    const input = convidarSchema.parse(raw);
    const papel = input.nivel === 'GESTAO' ? 'REPRESENTANTE_AUTORIZADO' as const : 'ADMINISTRATIVO' as const;
    const criado = await naGestao(sessao, empresaSolicitada, deps, async (tx, tenant) => {
        const empresaId = tenant.empresaComprovada;
        const convite = await criarConviteNaTransacao(tx, deps, { empresaId, email: input.email, nomeSugerido: input.nome ?? null, papel, criadoPor: sessao.usuario_id });
        await deps.registrarAuditoria({
            atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'CONVITE_CRIADO', entidadeTipo: 'CONVITE_ACESSO', entidadeId: convite.id,
            dadosDepois: { empresaId, papel, substituiuConviteVencido: convite.substituiu, resultado: 'SUCESSO' },
            origem: ORIGEM, requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent,
        }, tx);
        return { ...convite, empresaId, empresaNome: await nomeDaEmpresa(tx, empresaId) };
    });
    const envio = await enviarConvite(deps, { conviteId: criado.id, email: input.email, empresaNome: criado.empresaNome, papel, token: criado.token });
    await auditarEnvio(deps, sessao, ctx, criado.empresaId, criado.id, envio);
    return { conviteId: criado.id, expiraEm: criado.expiraEm, envio };
}

export async function alterarConviteNaEmpresa(sessao: SessaoAdmin, raw: unknown, ctx: ContextoRequisicao, deps: ConvitesEmpresaDeps = convitesDepsPadrao(), empresaSolicitada?: string | null) {
    const input = conviteSchema.parse(raw);
    if (input.acao === 'cancelar-convite') {
        return naGestao(sessao, empresaSolicitada, deps, async (tx, tenant) => {
            const empresaId = tenant.empresaComprovada;
            const c = await cancelarConviteNaTransacao(tx, empresaId, input.conviteId, sessao.usuario_id);
            await deps.registrarAuditoria({
                atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'CONVITE_CANCELADO', entidadeTipo: 'CONVITE_ACESSO', entidadeId: c.id,
                dadosDepois: { empresaId, resultado: 'SUCESSO' }, origem: ORIGEM, requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent,
            }, tx);
            return { conviteId: c.id, situacao: 'CANCELADO' as const };
        });
    }
    const renovado = await naGestao(sessao, empresaSolicitada, deps, async (tx, tenant) => {
        const empresaId = tenant.empresaComprovada;
        const r = await renovarConviteNaTransacao(tx, deps, empresaId, input.conviteId);
        await deps.registrarAuditoria({
            atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'CONVITE_RENOVADO', entidadeTipo: 'CONVITE_ACESSO', entidadeId: r.id,
            dadosDepois: { empresaId, linkAnteriorInvalidado: true, resultado: 'SUCESSO' }, origem: ORIGEM, requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent,
        }, tx);
        return { ...r, empresaId, empresaNome: await nomeDaEmpresa(tx, empresaId) };
    });
    const envio = await enviarConvite(deps, { conviteId: renovado.id, email: renovado.email, empresaNome: renovado.empresaNome, papel: renovado.papel, token: renovado.token });
    await auditarEnvio(deps, sessao, ctx, renovado.empresaId, renovado.id, envio);
    return { conviteId: renovado.id, expiraEm: renovado.expiraEm, envio };
}
