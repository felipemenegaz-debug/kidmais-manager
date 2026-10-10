import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { DbExecutor } from '../db/contracts';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import { travarUsuariosNaOrdem } from '../saas/provar-tenant.ts';
import { exigirOutraGestao, marcarAtor, revogarAssinaturaDaMembership } from '../autenticacao/usuarios.ts';
import { avaliarPerdaDeElegibilidade } from '../perfil/protecao-usuarios.ts';
import { ClienteServiceError } from '../clientes/services/errors.ts';
import { erroAcesso } from '../acessos/erros.ts';
import { emailObrigatorio, textoOpcional } from '../acessos/validacao.ts';
import { cancelarConviteNaTransacao, criarConviteNaTransacao, enviarConvite, renovarConviteNaTransacao } from '../acessos/convites.ts';
import { abrirPedidoNaTransacao, enviarPedido, INTERVALO_PEDIDOS_SEGUNDOS } from '../acessos/recuperacao.ts';
import { criarEnviarEmail } from '../acessos/email.ts';
import { encerrarSessoesSemAcesso, exigirDesenvolvedorNaTransacao, exigirReautenticacaoRecente } from './autorizacao.ts';
import { auditarPainel, type ContextoPainel } from './auditoria.ts';
import { registrarEnvio, type EmpresasDeps } from './empresas.ts';
import { painelDepsPadrao } from './interessadas.ts';
import { exigirVaga } from '../assinatura/limites-usuarios.ts';

/**
 * Usuários e acessos de UMA empresa, pelo painel do desenvolvedor.
 *
 * Usuário global (identidade) ≠ vínculo com a empresa (membership). Tudo aqui age só sobre a membership da empresa
 * informada (toda consulta filtra por empresa_id); outra empresa do mesmo usuário nunca é tocada.
 *   - desativar vínculo: ATIVA → SUSPENSA (reversível); a assinatura pela empresa é retirada; protege a última Gestão
 *     e a última administradora do Perfil; sessões só caem se a pessoa ficar sem nenhum outro acesso;
 *   - reativar vínculo: SUSPENSA → ATIVA;
 *   - papel: Gestão ↔ Equipe nesta empresa (memberships.papel), com a mesma proteção da última Gestão;
 *   - recuperação de senha: só dispara o e-mail; nunca mostra link, token ou senha.
 */
export function vinculosDepsPadrao(): EmpresasDeps {
    return { ...painelDepsPadrao, enviarEmail: criarEnviarEmail(), gerarToken: () => randomBytes(32).toString('base64url') };
}

const uuid = z.string().uuid().transform((v) => v.toLowerCase());

async function nomeDaEmpresa(tx: DbExecutor, empresaId: string) {
    const e = (await tx.query<{ nome: string }>('SELECT nome FROM empresas WHERE id = $1::uuid', [empresaId])).rows[0];
    if (!e)
        throw erroAcesso('NAO_ENCONTRADO', 'Empresa não encontrada.', 404);
    return e.nome;
}

// ---------------------------------------------------------------- Convites

const convidarSchema = z.object({
    email: emailObrigatorio,
    nome: textoOpcional(120),
    nivel: z.enum(['GESTAO', 'EQUIPE']),
}).strict();

export async function convidarUsuario(sessao: SessaoAdmin, empresaIdRaw: string, raw: unknown, ctx: ContextoPainel, deps: EmpresasDeps = vinculosDepsPadrao()) {
    const empresaId = uuid.parse(empresaIdRaw);
    const input = convidarSchema.parse(raw);
    const papel = input.nivel === 'GESTAO' ? 'REPRESENTANTE_AUTORIZADO' as const : 'ADMINISTRATIVO' as const;
    const criado = await deps.withTransaction(async (tx) => {
        await exigirDesenvolvedorNaTransacao(tx, sessao);
        const empresaNome = await nomeDaEmpresa(tx, empresaId);
        const convite = await criarConviteNaTransacao(tx, deps, { empresaId, email: input.email, nomeSugerido: input.nome ?? null, papel, criadoPor: sessao.usuario_id });
        await auditarPainel(deps.registrarAuditoria, tx, {
            atorId: sessao.usuario_id, acao: 'CONVITE_CRIADO', entidadeTipo: 'CONVITE_ACESSO', entidadeId: convite.id, empresaId, resultado: 'SUCESSO',
            depois: { email: input.email, papel, substituiuConviteVencido: convite.substituiu }, ctx,
        });
        return { ...convite, empresaNome };
    });
    const envio = await enviarConvite(deps, { conviteId: criado.id, email: input.email, empresaNome: criado.empresaNome, papel, token: criado.token });
    await registrarEnvio(deps, sessao, ctx, empresaId, criado.id, envio);
    return { conviteId: criado.id, expiraEm: criado.expiraEm, envio };
}

export async function reenviarConvite(sessao: SessaoAdmin, empresaIdRaw: string, conviteIdRaw: string, ctx: ContextoPainel, deps: EmpresasDeps = vinculosDepsPadrao()) {
    const empresaId = uuid.parse(empresaIdRaw), conviteId = uuid.parse(conviteIdRaw);
    const renovado = await deps.withTransaction(async (tx) => {
        await exigirDesenvolvedorNaTransacao(tx, sessao);
        const empresa = (await tx.query<{ nome: string; status: string }>('SELECT nome, status FROM empresas WHERE id = $1::uuid FOR SHARE', [empresaId])).rows[0];
        if (!empresa)
            throw erroAcesso('NAO_ENCONTRADO', 'Empresa não encontrada.', 404);
        if (empresa.status !== 'ATIVA')
            throw erroAcesso('CONFLITO', 'Só uma empresa ativa recebe convites. Reative a empresa antes.', 409);
        const r = await renovarConviteNaTransacao(tx, deps, empresaId, conviteId);
        await auditarPainel(deps.registrarAuditoria, tx, {
            atorId: sessao.usuario_id, acao: 'CONVITE_RENOVADO', entidadeTipo: 'CONVITE_ACESSO', entidadeId: r.id, empresaId, resultado: 'SUCESSO',
            depois: { email: r.email, linkAnteriorInvalidado: true }, ctx,
        });
        return { ...r, empresaNome: empresa.nome };
    });
    const envio = await enviarConvite(deps, { conviteId: renovado.id, email: renovado.email, empresaNome: renovado.empresaNome, papel: renovado.papel, token: renovado.token });
    await registrarEnvio(deps, sessao, ctx, empresaId, renovado.id, envio);
    return { conviteId: renovado.id, expiraEm: renovado.expiraEm, envio };
}

export async function cancelarConvite(sessao: SessaoAdmin, empresaIdRaw: string, conviteIdRaw: string, ctx: ContextoPainel, deps: EmpresasDeps = vinculosDepsPadrao()) {
    const empresaId = uuid.parse(empresaIdRaw), conviteId = uuid.parse(conviteIdRaw);
    return deps.withTransaction(async (tx) => {
        await exigirDesenvolvedorNaTransacao(tx, sessao);
        const c = await cancelarConviteNaTransacao(tx, empresaId, conviteId, sessao.usuario_id);
        await auditarPainel(deps.registrarAuditoria, tx, {
            atorId: sessao.usuario_id, acao: 'CONVITE_CANCELADO', entidadeTipo: 'CONVITE_ACESSO', entidadeId: c.id, empresaId, resultado: 'SUCESSO', depois: { email: c.email }, ctx,
        });
        return { conviteId: c.id, situacao: 'CANCELADO' as const };
    });
}

// ---------------------------------------------------------------- Vínculos

type Vinculo = { membership_id: string; usuario_id: string; papel: string; status: string; nome: string; email: string; conta_ativa: boolean; pode_assinar: boolean };

/** Trava usuário → empresa → membership (ordem dos fluxos de tenant) e devolve a membership DESTA empresa. */
async function vinculoTravado(tx: DbExecutor, sessao: SessaoAdmin, empresaId: string, usuarioId: string) {
    await travarUsuariosNaOrdem(tx, [usuarioId, sessao.usuario_id]);
    await exigirDesenvolvedorNaTransacao(tx, sessao);
    const empresa = (await tx.query<{ id: string }>('SELECT id FROM empresas WHERE id = $1::uuid FOR UPDATE', [empresaId])).rows[0];
    if (!empresa)
        throw erroAcesso('NAO_ENCONTRADO', 'Empresa não encontrada.', 404);
    const v = (await tx.query<Vinculo>(
        `SELECT m.id AS membership_id, m.usuario_id, m.papel, m.status, u.nome, u.email, u.ativo AS conta_ativa,
                EXISTS (SELECT 1 FROM empresa_membership_capacidades c WHERE c.membership_id = m.id AND c.empresa_id = m.empresa_id AND c.capacidade = 'CONTRATO_ASSINAR_EMPRESA' AND c.revogado_em IS NULL) AS pode_assinar
           FROM memberships m JOIN usuarios_administrativos u ON u.id = m.usuario_id
          WHERE m.empresa_id = $1::uuid AND m.usuario_id = $2::uuid FOR UPDATE OF m`, [empresaId, usuarioId])).rows[0];
    if (!v)
        throw erroAcesso('NAO_ENCONTRADO', 'Esta pessoa não tem vínculo com esta empresa.', 404);
    return v;
}

const papelSchema = z.object({ nivel: z.enum(['GESTAO', 'EQUIPE']) }).strict();

export async function alterarPapelVinculo(sessao: SessaoAdmin, empresaIdRaw: string, usuarioIdRaw: string, raw: unknown, ctx: ContextoPainel, deps: EmpresasDeps = vinculosDepsPadrao()) {
    exigirReautenticacaoRecente(sessao);
    const empresaId = uuid.parse(empresaIdRaw), usuarioId = uuid.parse(usuarioIdRaw);
    const papel = papelSchema.parse(raw).nivel === 'GESTAO' ? 'REPRESENTANTE_AUTORIZADO' : 'ADMINISTRATIVO';
    return deps.withTransaction(async (tx) => {
        const v = await vinculoTravado(tx, sessao, empresaId, usuarioId);
        if (v.status !== 'ATIVA')
            throw erroAcesso('CONFLITO', 'Só um vínculo ativo muda de papel. Reative o vínculo antes.', 409);
        if (v.papel === papel)
            return { papel, alterado: false };
        if (v.papel === 'REPRESENTANTE_AUTORIZADO')
            await traduzirUltimaGestao(() => exigirOutraGestao(tx, empresaId, usuarioId));
        await tx.query('UPDATE memberships SET papel = $3 WHERE id = $1::uuid AND empresa_id = $2::uuid', [v.membership_id, empresaId, papel]);
        const assinaturaRetirada = papel !== 'REPRESENTANTE_AUTORIZADO'
            ? await revogarAssinaturaDaMembership(tx, empresaId, v.membership_id, sessao.usuario_id, 'Papel alterado para Equipe pelo painel do desenvolvedor')
            : 0;
        await auditarPainel(deps.registrarAuditoria, tx, {
            atorId: sessao.usuario_id, acao: 'MEMBERSHIP_PAPEL_ALTERADO', entidadeTipo: 'MEMBERSHIP', entidadeId: v.membership_id, empresaId, resultado: 'SUCESSO',
            antes: { papel: v.papel }, depois: { papel, usuarioId, assinaturaRetirada: assinaturaRetirada > 0 }, ctx,
        });
        return { papel, alterado: true };
    });
}

async function traduzirUltimaGestao(trabalho: () => Promise<void>) {
    try {
        await trabalho();
    }
    catch (error) {
        if (error instanceof ClienteServiceError && error.code === 'PERFIL_ULTIMA_GESTAO')
            throw erroAcesso('ULTIMA_GESTAO', 'Esta pessoa é a última Gestão ativa desta empresa. Promova outra pessoa antes.', 409);
        throw error;
    }
}

const situacaoVinculoSchema = z.object({ motivo: z.string().trim().min(3, 'Informe o motivo.').max(500) }).strict();

export async function alterarSituacaoVinculo(sessao: SessaoAdmin, empresaIdRaw: string, usuarioIdRaw: string, acao: 'desativar' | 'reativar', raw: unknown, ctx: ContextoPainel, deps: EmpresasDeps = vinculosDepsPadrao()) {
    exigirReautenticacaoRecente(sessao);
    const empresaId = uuid.parse(empresaIdRaw), usuarioId = uuid.parse(usuarioIdRaw);
    const { motivo } = situacaoVinculoSchema.parse(raw);
    if (acao === 'desativar' && usuarioId === sessao.usuario_id)
        throw erroAcesso('CONFLITO', 'Você não pode desativar o próprio vínculo pelo painel.', 409);
    return deps.withTransaction(async (tx) => {
        const v = await vinculoTravado(tx, sessao, empresaId, usuarioId);
        if (acao === 'reativar') {
            if (v.status !== 'SUSPENSA')
                throw erroAcesso('CONFLITO', v.status === 'ATIVA' ? 'Este vínculo já está ativo.' : 'Só um vínculo desativado pode ser reativado.', 409);
            if (v.conta_ativa) await exigirVaga(tx, empresaId);
            await marcarAtor(tx, sessao.usuario_id);
            await tx.query("UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid AND empresa_id = $2::uuid", [v.membership_id, empresaId]);
            await auditarPainel(deps.registrarAuditoria, tx, {
                atorId: sessao.usuario_id, acao: 'MEMBERSHIP_REATIVADA', entidadeTipo: 'MEMBERSHIP', entidadeId: v.membership_id, empresaId, resultado: 'SUCESSO',
                antes: { status: v.status }, depois: { status: 'ATIVA', usuarioId, contaAtiva: v.conta_ativa }, justificativa: motivo, ctx,
            });
            return { statusVinculo: 'ATIVA' as const, contaAtiva: v.conta_ativa, sessoesEncerradas: 0 };
        }
        if (v.status !== 'ATIVA')
            throw erroAcesso('CONFLITO', v.status === 'SUSPENSA' ? 'Este vínculo já está desativado.' : 'Só um vínculo ativo pode ser desativado.', 409);
        if (v.papel === 'REPRESENTANTE_AUTORIZADO')
            await traduzirUltimaGestao(() => exigirOutraGestao(tx, empresaId, usuarioId));
        const avaliacao = await avaliarPerdaDeElegibilidade(tx, { usuarioId, modo: 'revogar-administrar', empresaId });
        if (avaliacao.recusado)
            throw erroAcesso('ULTIMA_ADMINISTRADORA', 'Esta pessoa é a última administradora do Perfil da empresa. Conceda a outra pessoa antes.', 409);
        await marcarAtor(tx, sessao.usuario_id);
        await tx.query("UPDATE memberships SET status = 'SUSPENSA' WHERE id = $1::uuid AND empresa_id = $2::uuid", [v.membership_id, empresaId]);
        const assinatura = await revogarAssinaturaDaMembership(tx, empresaId, v.membership_id, sessao.usuario_id, 'Vínculo desativado pelo painel do desenvolvedor');
        const sessoes = await encerrarSessoesSemAcesso(tx, [usuarioId]);
        await auditarPainel(deps.registrarAuditoria, tx, {
            atorId: sessao.usuario_id, acao: 'MEMBERSHIP_DESATIVADA', entidadeTipo: 'MEMBERSHIP', entidadeId: v.membership_id, empresaId, resultado: 'SUCESSO',
            antes: { status: v.status }, depois: { status: 'SUSPENSA', usuarioId, assinaturaRetirada: assinatura > 0, sessoesEncerradas: sessoes.sessoes }, justificativa: motivo, ctx,
        });
        return { statusVinculo: 'SUSPENSA' as const, contaAtiva: v.conta_ativa, sessoesEncerradas: sessoes.sessoes };
    });
}

// ---------------------------------------------------------------- Recuperação de senha

export async function solicitarRecuperacaoPeloPainel(sessao: SessaoAdmin, empresaIdRaw: string, usuarioIdRaw: string, ctx: ContextoPainel, deps: EmpresasDeps = vinculosDepsPadrao()) {
    const empresaId = uuid.parse(empresaIdRaw), usuarioId = uuid.parse(usuarioIdRaw);
    const aberto = await deps.withTransaction(async (tx) => {
        const v = await vinculoTravado(tx, sessao, empresaId, usuarioId);
        if (v.status === 'REVOGADA')
            throw erroAcesso('CONFLITO', 'O vínculo desta pessoa com a empresa foi removido.', 409);
        if (!v.conta_ativa)
            throw erroAcesso('CONFLITO', 'A conta desta pessoa está desativada na plataforma; a recuperação não se aplica.', 409);
        const r = await abrirPedidoNaTransacao(tx, deps, { id: usuarioId, email: v.email }, 'PAINEL', sessao.usuario_id);
        if (r.tipo === 'recente')
            throw erroAcesso('LIMITE_TENTATIVAS', `Já há um pedido recente para esta conta. Aguarde ${r.aguardar} segundos (intervalo mínimo de ${INTERVALO_PEDIDOS_SEGUNDOS / 60} minutos).`, 429, { retryAfterSegundos: r.aguardar });
        await auditarPainel(deps.registrarAuditoria, tx, {
            atorId: sessao.usuario_id, acao: 'RECUPERACAO_SOLICITADA', entidadeTipo: 'USUARIO_ADMINISTRATIVO', entidadeId: usuarioId, empresaId, resultado: 'SUCESSO',
            depois: { origem: 'PAINEL', pedidoId: r.pedidoId, pedidosAnterioresInvalidados: r.invalidados }, ctx,
        });
        return { pedido: { pedidoId: r.pedidoId, token: r.token }, email: v.email };
    });
    const envio = await enviarPedido(deps, aberto.pedido, aberto.email);
    await auditarPainel(deps.registrarAuditoria, undefined, {
        atorId: sessao.usuario_id, acao: envio.enviado ? 'RECUPERACAO_ENVIADA' : 'RECUPERACAO_ENVIO_FALHOU', entidadeTipo: 'USUARIO_ADMINISTRATIVO', entidadeId: usuarioId, empresaId,
        resultado: envio.enviado ? 'SUCESSO' : 'FALHA', depois: { pedidoId: aberto.pedido.pedidoId, destino: envio.destino, motivo: envio.enviado ? null : envio.motivo }, ctx,
    });
    return envio;
}
