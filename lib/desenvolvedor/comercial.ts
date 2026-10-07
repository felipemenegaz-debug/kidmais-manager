import { z } from 'zod';
import type { DbExecutor } from '../db/contracts';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import { erroAcesso } from '../acessos/erros.ts';
import { comercialInstalado, lerEstadoComercial } from '../assinatura/estado.ts';
import { concederExcecao, estenderTeste, revogarExcecao } from '../assinatura/servico.ts';
import { EXTENSAO_TESTE_MAXIMA_DIAS } from '../assinatura/configuracao.ts';
import { exigirDesenvolvedorNaTransacao, exigirReautenticacaoRecente } from './autorizacao.ts';
import { auditarPainel, sanitizarAuditoria, type ContextoPainel } from './auditoria.ts';
import { painelDepsPadrao, type PainelDeps } from './interessadas.ts';

/**
 * Painel comercial do desenvolvedor (E5): situação comercial por empresa, exceções, eventos do provedor e histórico
 * auditado, mais as intervenções permitidas — estender teste, conceder cortesia/acesso temporário e revogar exceção.
 *
 * Toda intervenção exige: concessão de desenvolvedor na transação, senha confirmada há no máximo 5 minutos, motivo
 * (5–500) e prazo; é auditada com ator, empresa, antes/depois e motivo. Nenhuma intervenção comercial concede
 * plataforma_desenvolvedores, papel global, vínculo em empresa ou leitura de dados de negócio — só mexe nos eixos
 * comerciais da empresa alvo (067/068). Concessão de desenvolvedor continua só pelo CLI.
 */
const ISO = (coluna: string) => `to_char((${coluna}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
export const ACOES_COMERCIAIS = ['COMERCIAL_TESTE_ESTENDIDO', 'COMERCIAL_EXCECAO_CONCEDIDA', 'COMERCIAL_EXCECAO_REVOGADA', 'COMERCIAL_ACAO_RECUSADA'] as const;

export type ComercialResumo = { instalado: boolean; cobrado: boolean; situacao: string | null; nivel: string; motivo: string; ate: string | null; testeFim: string | null; periodoAtualFim: string | null };

export async function comercialResumo(tx: DbExecutor, empresaId: string): Promise<ComercialResumo> {
    const e = await lerEstadoComercial(tx, empresaId);
    return {
        instalado: e.instalado, cobrado: e.assinatura !== null, situacao: e.assinatura?.situacao ?? null, nivel: e.acesso.nivel, motivo: e.acesso.motivo,
        ate: e.acesso.ate, testeFim: e.assinatura?.testeFim ?? null, periodoAtualFim: e.assinatura?.periodoAtualFim ?? null,
    };
}

/** Detalhe comercial para a ficha da empresa (o desenvolvedor vê os motivos internos das exceções). */
export async function comercialDaEmpresa(tx: DbExecutor, empresaId: string) {
    const resumo = await comercialResumo(tx, empresaId);
    if (!resumo.instalado)
        return { ...resumo, ciclo: null, testeInicio: null, emAtrasoDesde: null, versao: null, excecoes: [], eventos: [], historico: [] };
    const a = (await tx.query<{ ciclo: string | null; teste_inicio: string; em_atraso_desde: string | null; versao: number }>(
        `SELECT ciclo, ${ISO('teste_inicio')} AS teste_inicio, ${ISO('em_atraso_desde')} AS em_atraso_desde, versao FROM empresa_assinaturas WHERE empresa_id = $1::uuid`, [empresaId])).rows[0];
    const excecoes = (await tx.query<{ id: string; tipo: string; valida_ate: string; motivo: string; criado_em: string; criado_por: string | null; revogada_em: string | null; motivo_revogacao: string | null; vigente: boolean }>(
        `SELECT x.id, x.tipo, ${ISO('x.valida_ate')} AS valida_ate, x.motivo, ${ISO('x.criado_em')} AS criado_em, u.nome AS criado_por,
                ${ISO('x.revogada_em')} AS revogada_em, x.motivo_revogacao, (x.revogada_em IS NULL AND x.valida_ate > clock_timestamp()) AS vigente
           FROM empresa_excecoes_comerciais x LEFT JOIN usuarios_administrativos u ON u.id = x.criado_por
          WHERE x.empresa_id = $1::uuid ORDER BY x.criado_em DESC LIMIT 30`, [empresaId])).rows;
    const temEventos = (await tx.query<{ ok: boolean }>("SELECT to_regclass('public.cobranca_eventos') IS NOT NULL AS ok")).rows[0]?.ok === true;
    const eventos = temEventos ? (await tx.query<{ tipo: string; situacao: string; recebido_em: string; processado_em: string | null; tentativas: number }>(
        `SELECT tipo, situacao, ${ISO('recebido_em')} AS recebido_em, ${ISO('processado_em')} AS processado_em, tentativas
           FROM cobranca_eventos WHERE empresa_id = $1::uuid ORDER BY recebido_em DESC LIMIT 20`, [empresaId])).rows : [];
    const historico = (await tx.query<{ id: string; acao: string; criado_em: string; ator: string | null; justificativa: string | null; dados_depois: Record<string, unknown> | null }>(
        `SELECT a.id, a.acao, ${ISO('a.criado_em')} AS criado_em, u.nome AS ator, a.justificativa, a.dados_depois
           FROM auditoria a LEFT JOIN usuarios_administrativos u ON u.id = a.usuario_id
          WHERE a.entidade_tipo = 'EMPRESA' AND a.entidade_id = $1::uuid AND (a.acao = ANY($2::text[]) OR a.origem = 'COBRANCA')
          ORDER BY a.criado_em DESC LIMIT 30`, [empresaId, [...ACOES_COMERCIAIS]])).rows
        .map((h) => ({ ...h, dados_depois: sanitizarAuditoria(h.dados_depois) }));
    return {
        ...resumo, ciclo: a?.ciclo ?? null, testeInicio: a?.teste_inicio ?? null, emAtrasoDesde: a?.em_atraso_desde ?? null, versao: a?.versao ?? null,
        excecoes: excecoes.map((x) => ({ id: x.id, tipo: x.tipo, validaAte: x.valida_ate, motivo: x.motivo, criadoEm: x.criado_em, criadoPor: x.criado_por, revogadaEm: x.revogada_em, motivoRevogacao: x.motivo_revogacao, vigente: x.vigente })),
        eventos: eventos.map((ev) => ({ tipo: ev.tipo, situacao: ev.situacao, recebidoEm: ev.recebido_em, processadoEm: ev.processado_em, tentativas: ev.tentativas })),
        historico,
    };
}

const motivo = z.string().trim().min(5, 'Informe o motivo (5 a 500 caracteres).').max(500);
const operacaoSchema = z.discriminatedUnion('operacao', [
    z.object({ operacao: z.literal('estender-teste'), dias: z.number().int().min(1).max(EXTENSAO_TESTE_MAXIMA_DIAS), motivo }).strict(),
    z.object({ operacao: z.literal('conceder-excecao'), tipo: z.enum(['CORTESIA', 'ACESSO_TEMPORARIO']), dias: z.number().int().min(1).max(365), motivo }).strict(),
    z.object({ operacao: z.literal('revogar-excecao'), excecaoId: z.string().uuid(), motivo }).strict(),
]);

export async function operarComercial(sessao: SessaoAdmin, id: string, raw: unknown, ctx: ContextoPainel, deps: PainelDeps = painelDepsPadrao) {
    exigirReautenticacaoRecente(sessao);
    const empresaId = z.string().uuid().parse(id);
    const input = operacaoSchema.parse(raw);
    return deps.withTransaction(async (tx) => {
        await exigirDesenvolvedorNaTransacao(tx, sessao);
        const empresa = (await tx.query<{ status: string }>('SELECT status FROM empresas WHERE id = $1::uuid FOR UPDATE', [empresaId])).rows[0];
        if (!empresa)
            throw erroAcesso('NAO_ENCONTRADO', 'Empresa não encontrada.', 404);
        if (!await comercialInstalado(tx))
            throw erroAcesso('PAINEL_INDISPONIVEL', 'O modelo comercial ainda não está instalado neste ambiente.', 503);
        const antes = await comercialResumo(tx, empresaId);
        const base = { atorId: sessao.usuario_id, entidadeTipo: 'EMPRESA', entidadeId: empresaId, empresaId, resultado: 'SUCESSO' as const, justificativa: input.motivo, ctx };
        let resultado: Record<string, unknown>;
        if (input.operacao === 'estender-teste') {
            const r = await estenderTeste(tx, { empresaId, dias: input.dias, motivo: input.motivo, usuarioId: sessao.usuario_id });
            await auditarPainel(deps.registrarAuditoria, tx, { ...base, acao: 'COMERCIAL_TESTE_ESTENDIDO', antes: { testeFim: r.testeFimAntes, nivel: antes.nivel }, depois: { testeFim: r.testeFimDepois, dias: input.dias, excecaoId: r.excecaoId } });
            resultado = { testeFim: r.testeFimDepois, excecaoId: r.excecaoId };
        }
        else if (input.operacao === 'conceder-excecao') {
            const r = await concederExcecao(tx, { empresaId, tipo: input.tipo, dias: input.dias, motivo: input.motivo, usuarioId: sessao.usuario_id });
            await auditarPainel(deps.registrarAuditoria, tx, { ...base, acao: 'COMERCIAL_EXCECAO_CONCEDIDA', antes: { nivel: antes.nivel }, depois: { tipo: r.tipo, validaAte: r.validaAte, dias: input.dias, excecaoId: r.excecaoId } });
            resultado = { excecaoId: r.excecaoId, validaAte: r.validaAte };
        }
        else {
            const r = await revogarExcecao(tx, { empresaId, excecaoId: input.excecaoId, motivo: input.motivo, usuarioId: sessao.usuario_id });
            await auditarPainel(deps.registrarAuditoria, tx, { ...base, acao: 'COMERCIAL_EXCECAO_REVOGADA', antes: { nivel: antes.nivel, tipo: r.tipo, validaAte: r.validaAte }, depois: { excecaoId: r.excecaoId } });
            resultado = { excecaoId: r.excecaoId };
        }
        return { ...resultado, operacao: input.operacao, comercial: await comercialResumo(tx, empresaId) };
    });
}
