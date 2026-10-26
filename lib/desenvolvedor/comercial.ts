import { z } from 'zod';
import type { DbExecutor } from '../db/contracts';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import { erroAcesso } from '../acessos/erros.ts';
import { comercialInstalado, lerEstadoComercial } from '../assinatura/estado.ts';
import { concederExcecao, estenderTeste, iniciarTeste, revogarExcecao } from '../assinatura/servico.ts';
import { EXTENSAO_TESTE_MAXIMA_DIAS, TESTE_DIAS_MAXIMO } from '../assinatura/configuracao.ts';
import { empresaIsenta } from '../assinatura/ofertas.ts';
import { consultarBeneficioFundadorDesenvolvedor } from '../assinatura/beneficio-fundador.ts';
import { exigirDesenvolvedorNaTransacao, exigirReautenticacaoRecente } from './autorizacao.ts';
import { auditarPainel, sanitizarAuditoria, type ContextoPainel } from './auditoria.ts';
import { painelDepsPadrao, type PainelDeps } from './interessadas.ts';
import { documentoVinculado, exigirNomeCivil, travarDocumento } from '../assinatura/documento-contratante.ts';
import { concluirContinuidade, continuidadesDaEmpresa, recuperarVinculo, registrarContinuidade, type ProvedorRecuperacao } from './continuidade.ts';
import { clienteAsaasDoAmbiente } from '../assinatura/asaas.ts';
import { concluirArrependimento, enviarEmailConclusao, manifestacoesDaEmpresa, notificarRegistro, registrarArrependimentoAtendimento,
    registrarComunicacaoIntermediador } from '../assinatura/arrependimento.ts';
import { criarEnviarEmail, type EnviarEmail } from '../acessos/email.ts';

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
export const ACOES_COMERCIAIS = ['COMERCIAL_TESTE_INICIADO', 'COMERCIAL_TESTE_ESTENDIDO','COMERCIAL_EXCECAO_CONCEDIDA', 'COMERCIAL_EXCECAO_REVOGADA', 'COMERCIAL_ACAO_RECUSADA',
    'COMERCIAL_CONTINUIDADE_REGISTRADA', 'COMERCIAL_CONTINUIDADE_CONCLUIDA', 'COMERCIAL_VINCULO_RECUPERADO',
    'COMERCIAL_ARREPENDIMENTO_COMUNICADO', 'COMERCIAL_ARREPENDIMENTO_CONCLUIDO', 'COMERCIAL_ARREPENDIMENTO_REGISTRADO'] as const;

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
        return { ...resumo, plano: null, ciclo: null, testeInicio: null, emAtrasoDesde: null, versao: null, excecoes: [], eventos: [], historico: [], continuidades: [], arrependimentos: [], fundador: null };
    // plano (074a) por to_jsonb: sem a coluna, vem null e a ficha mostra o legado Único.
    const a = (await tx.query<{ ciclo: string | null; teste_inicio: string; em_atraso_desde: string | null; versao: number; plano: string | null }>(
        `SELECT ciclo, ${ISO('teste_inicio')} AS teste_inicio, ${ISO('em_atraso_desde')} AS em_atraso_desde, versao, to_jsonb(a)->>'plano' AS plano
           FROM empresa_assinaturas a WHERE empresa_id = $1::uuid`, [empresaId])).rows[0];
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
        ...resumo, plano: a?.plano ?? null, ciclo: a?.ciclo ?? null, testeInicio: a?.teste_inicio ?? null, emAtrasoDesde: a?.em_atraso_desde ?? null, versao: a?.versao ?? null,
        excecoes: excecoes.map((x) => ({ id: x.id, tipo: x.tipo, validaAte: x.valida_ate, motivo: x.motivo, criadoEm: x.criado_em, criadoPor: x.criado_por, revogadaEm: x.revogada_em, motivoRevogacao: x.motivo_revogacao, vigente: x.vigente })),
        eventos: eventos.map((ev) => ({ tipo: ev.tipo, situacao: ev.situacao, recebidoEm: ev.recebido_em, processadoEm: ev.processado_em, tentativas: ev.tentativas })),
        historico,
        continuidades: await continuidadesDaEmpresa(tx, empresaId),
        arrependimentos: await manifestacoesDaEmpresa(tx, empresaId, 20),
        fundador: await consultarBeneficioFundadorDesenvolvedor(tx, empresaId),
    };
}

const motivo = z.string().trim().min(5, 'Informe o motivo (5 a 500 caracteres).').max(500);
const operacaoSchema = z.discriminatedUnion('operacao', [
    z.object({ operacao: z.literal('iniciar-teste'), dias: z.number().int().min(1).max(TESTE_DIAS_MAXIMO), motivo }).strict(),
    z.object({ operacao: z.literal('estender-teste'), dias: z.number().int().min(1).max(EXTENSAO_TESTE_MAXIMA_DIAS), motivo }).strict(),
    z.object({ operacao: z.literal('conceder-excecao'), tipo: z.enum(['CORTESIA', 'ACESSO_TEMPORARIO']), dias: z.number().int().min(1).max(365), motivo }).strict(),
    z.object({ operacao: z.literal('revogar-excecao'), excecaoId: z.string().uuid(), motivo }).strict(),
    // D5: continuidade assistida do documento (091). O motivo é a justificativa; instrumento e evidências ficam na linha.
    z.object({ operacao: z.literal('registrar-continuidade'), tipo: z.enum(['RETIFICACAO', 'MESMA_TITULARIDADE', 'CESSAO']), documentoNovo: z.string().max(40),
        nomeNovo: z.string().trim().min(2).max(200), instrumento: z.string().trim().min(5).max(300), evidencias: z.string().trim().min(5).max(1000),
        dataEfetiva: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), motivo }).strict(),
    z.object({ operacao: z.literal('concluir-continuidade'), continuidadeId: z.string().uuid(), motivo }).strict(),
    // Grupo C (097): acompanhamento das manifestações de arrependimento pelo atendimento.
    // Pedido recebido pelo canal oficial (e-mail), registrado pelo atendimento com a data real do recebimento.
    z.object({ operacao: z.literal('arrependimento-registrar'), chave: z.string().uuid(), emailSolicitante: z.string().trim().email().max(320),
        recebidoEm: z.string().trim().max(40), referencia: z.string().trim().min(5).max(400), motivo }).strict(),
    z.object({ operacao: z.literal('arrependimento-comunicar'), protocolo: z.string().regex(/^KA-[0-9]{8}-[0-9A-HJKMNP-TV-Z]{8}$/),
        referencia: z.string().trim().min(3).max(300), motivo }).strict(),
    z.object({ operacao: z.literal('arrependimento-concluir'), protocolo: z.string().regex(/^KA-[0-9]{8}-[0-9A-HJKMNP-TV-Z]{8}$/),
        situacao: z.enum(['RESTITUIDO', 'NAO_APLICAVEL']), referencia: z.string().trim().min(5).max(500), valorCentavos: z.number().int().positive().nullish(),
        cobrancaIds: z.array(z.string().trim().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(50).nullish(),
        assinaturaId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,100}$/).nullish(), motivo }).strict(),
    z.object({ operacao: z.literal('recuperar-vinculo'), assinaturaId: z.string().trim().min(3).max(100).regex(/^[A-Za-z0-9_-]+$/), motivo }).strict(),
]);

/**
 * Piloto e conversão de contratante provisionada (22/10/2026): a empresa criada pelo painel nasce SEM cobrança (sem linha
 * em empresa_assinaturas) e, assim, não vê planos nem a condição Fundador. Esta operação cria a assinatura em TESTE com o
 * CPF ou CNPJ do cadastro administrativo (o mesmo `iniciarTeste` do cadastro público: datas do relógio do banco, documento único),
 * para um prazo de 1 a 90 dias. A partir daí vale a régua comum (COMPLETO até o fim do teste; depois somente leitura)
 * e, com a venda ligada, a Gestão contrata pela tela. Recusa: empresa não ATIVA, a Kidmais, isenta, já com situação
 * comercial ou sem documento válido no cadastro. CPF só com a 091 e ASSINATURA_CPF_ATIVO (22/10/2026); antes disso, CPF_INDISPONIVEL.
 * Sem volta: a assinatura não é apagada.
 */
async function iniciarTesteDaContratante(tx: DbExecutor, empresa: { id: string; codigo: string; status: string }, dias: number, env: Record<string, string | undefined> = process.env) {
    if (empresa.status !== 'ATIVA')
        throw erroAcesso('CONFLITO', 'Só empresa ativa recebe teste.', 409);
    if (empresa.codigo === 'kidmais')
        throw erroAcesso('CONFLITO', 'A Kidmais não tem cobrança.', 409);
    if (await empresaIsenta(tx, empresa.id))
        throw erroAcesso('CONFLITO', 'Empresa isenta não recebe teste nem cobrança.', 409);
    const cadastro = (await tx.query<{ documento_fiscal: string | null; nome_empresarial: string | null }>(
        'SELECT documento_fiscal, nome_empresarial FROM plataforma_empresas_cadastro WHERE empresa_id = $1::uuid', [empresa.id])).rows[0];
    const documento = cadastro?.documento_fiscal ?? null;
    if (!documento)
        throw erroAcesso('DADOS_INVALIDOS', 'Cadastre o CPF ou CNPJ da contratante na ficha antes de iniciar o teste.', 400, { campo: 'documentoFiscal' });
    exigirNomeCivil(documento, cadastro?.nome_empresarial);
    await travarDocumento(tx, documento);
    if (await documentoVinculado(tx, documento, empresa.id))
        throw erroAcesso('CONFLITO', 'Este documento já está vinculado a outra contratante (inclusive em continuidade de documento).', 409, { campo: 'documentoFiscal' });
    return iniciarTeste(tx, { empresaId: empresa.id, documento, dias, env });
}

/**
 * Executa o trabalho na transação e, só depois do COMMIT, a ação posterior (e-mails do arrependimento). A ação posterior
 * é melhor esforço: o resultado dela entra na resposta, mas falha nunca desfaz o que foi gravado.
 */
export async function comPosCommit<T extends Record<string, unknown>>(withTransaction: PainelDeps['withTransaction'],
    trabalho: (tx: DbExecutor, depois: (acao: () => Promise<Record<string, unknown>>) => void) => Promise<T>): Promise<T> {
    let posterior: (() => Promise<Record<string, unknown>>) | null = null;
    const r = await withTransaction((tx) => trabalho(tx as unknown as DbExecutor, (acao) => { posterior = acao; }));
    if (!posterior) return r;
    try { return { ...r, ...await (posterior as () => Promise<Record<string, unknown>>)() }; }
    catch { return r; }
}

export async function operarComercial(sessao: SessaoAdmin, id: string, raw: unknown, ctx: ContextoPainel,
    deps: PainelDeps & { provedor?: () => ProvedorRecuperacao | null; enviarEmail?: EnviarEmail | null } = painelDepsPadrao) {
    exigirReautenticacaoRecente(sessao);
    const empresaId = z.string().uuid().parse(id);
    const input = operacaoSchema.parse(raw);
    const notificacao = { withTransaction: deps.withTransaction as never, env: process.env, enviarEmail: deps.enviarEmail === undefined ? criarEnviarEmail() : deps.enviarEmail };
    return comPosCommit(deps.withTransaction, async (tx, depois) => {
        await exigirDesenvolvedorNaTransacao(tx, sessao);
        const empresa = (await tx.query<{ status: string; codigo: string }>('SELECT status, codigo FROM empresas WHERE id = $1::uuid FOR UPDATE', [empresaId])).rows[0];
        if (!empresa)
            throw erroAcesso('NAO_ENCONTRADO', 'Empresa não encontrada.', 404);
        if (!await comercialInstalado(tx))
            throw erroAcesso('PAINEL_INDISPONIVEL', 'O modelo comercial ainda não está instalado neste ambiente.', 503);
        const antes = await comercialResumo(tx, empresaId);
        const base = { atorId: sessao.usuario_id, entidadeTipo: 'EMPRESA', entidadeId: empresaId, empresaId, resultado: 'SUCESSO' as const, justificativa: input.motivo, ctx };
        let resultado: Record<string, unknown>;
        if (input.operacao === 'iniciar-teste') {
            const r = await iniciarTesteDaContratante(tx, { id: empresaId, codigo: empresa.codigo, status: empresa.status }, input.dias);
            await auditarPainel(deps.registrarAuditoria, tx, { ...base, acao: 'COMERCIAL_TESTE_INICIADO', antes: { cobrado: antes.cobrado, nivel: antes.nivel }, depois: { testeInicio: r.testeInicio, testeFim: r.testeFim, dias: r.dias } });
            resultado = { testeInicio: r.testeInicio, testeFim: r.testeFim };
        }
        else if (input.operacao === 'estender-teste') {
            const r = await estenderTeste(tx, { empresaId, dias: input.dias, motivo: input.motivo, usuarioId: sessao.usuario_id });
            await auditarPainel(deps.registrarAuditoria, tx, { ...base, acao: 'COMERCIAL_TESTE_ESTENDIDO', antes: { testeFim: r.testeFimAntes, nivel: antes.nivel }, depois: { testeFim: r.testeFimDepois, dias: input.dias, excecaoId: r.excecaoId } });
            resultado = { testeFim: r.testeFimDepois, excecaoId: r.excecaoId };
        }
        else if (input.operacao === 'conceder-excecao') {
            const r = await concederExcecao(tx, { empresaId, tipo: input.tipo, dias: input.dias, motivo: input.motivo, usuarioId: sessao.usuario_id });
            await auditarPainel(deps.registrarAuditoria, tx, { ...base, acao: 'COMERCIAL_EXCECAO_CONCEDIDA', antes: { nivel: antes.nivel }, depois: { tipo: r.tipo, validaAte: r.validaAte, dias: input.dias, excecaoId: r.excecaoId } });
            resultado = { excecaoId: r.excecaoId, validaAte: r.validaAte };
        }
        else if (input.operacao === 'registrar-continuidade') {
            const r = await registrarContinuidade(tx, { empresaId, usuarioId: sessao.usuario_id, tipo: input.tipo, documentoNovo: input.documentoNovo, nomeNovo: input.nomeNovo,
                instrumento: input.instrumento, evidencias: input.evidencias, dataEfetiva: input.dataEfetiva });
            await auditarPainel(deps.registrarAuditoria, tx, { ...base, acao: 'COMERCIAL_CONTINUIDADE_REGISTRADA', antes: { documentoAnterior: r.documentoAnterior },
                depois: { continuidadeId: r.continuidadeId, tipo: r.tipo, situacao: r.situacao, documentoNovo: r.documentoNovo, instrumento: input.instrumento, dataEfetiva: input.dataEfetiva } });
            resultado = { continuidadeId: r.continuidadeId, situacao: r.situacao };
        }
        else if (input.operacao === 'arrependimento-registrar') {
            const r = await registrarArrependimentoAtendimento(tx, { empresaId, atendenteId: sessao.usuario_id, chave: input.chave, emailSolicitante: input.emailSolicitante,
                recebidoEm: input.recebidoEm, referencia: input.referencia, requestId: ctx.requestId });
            if (!r.repetido)
                await auditarPainel(deps.registrarAuditoria, tx, { ...base, acao: 'COMERCIAL_ARREPENDIMENTO_REGISTRADO', antes: null,
                    depois: { protocolo: r.m.protocolo, canal: 'ATENDIMENTO', recebidoEm: r.m.solicitadoEm } });
            resultado = { protocolo: r.m.protocolo, repetido: r.repetido };
            if (!r.repetido) depois(() => notificarRegistro(notificacao, r));
        }
        else if (input.operacao === 'arrependimento-comunicar') {
            const r = await registrarComunicacaoIntermediador(tx, { empresaId, protocolo: input.protocolo, referencia: input.referencia });
            await auditarPainel(deps.registrarAuditoria, tx, { ...base, acao: 'COMERCIAL_ARREPENDIMENTO_COMUNICADO', antes: { comunicado: false },
                depois: { protocolo: r.protocolo, referencia: input.referencia } });
            resultado = { protocolo: r.protocolo };
        }
        else if (input.operacao === 'arrependimento-concluir') {
            const r = await concluirArrependimento(tx, { empresaId, protocolo: input.protocolo, usuarioId: sessao.usuario_id, situacao: input.situacao,
                referencia: input.referencia, valorCentavos: input.valorCentavos ?? null, cobrancaIds: input.cobrancaIds ?? null, assinaturaId: input.assinaturaId ?? null },
                deps.provedor ? deps.provedor() : clienteAsaasDoAmbiente(process.env).cliente);
            await auditarPainel(deps.registrarAuditoria, tx, { ...base, acao: 'COMERCIAL_ARREPENDIMENTO_CONCLUIDO', antes: { situacao: 'RECEBIDO' },
                depois: { protocolo: r.protocolo, situacao: r.situacao, valorCentavos: input.valorCentavos ?? null, cobrancaIds: input.cobrancaIds ?? null, assinaturaId: input.assinaturaId ?? null,
                    encerrouAcesso: r.encerrou, mesmaAssinatura: r.mesmaAssinatura, evidenciaAssinatura: r.evidencia } });
            resultado = { protocolo: r.protocolo, situacao: r.situacao, encerrou: r.encerrou, mesmaAssinatura: r.mesmaAssinatura, evidencia: r.evidencia };
            depois(async () => ({ emailConclusao: await enviarEmailConclusao(notificacao, empresaId, r.protocolo) }));
        }
        else if (input.operacao === 'recuperar-vinculo') {
            const provedor = deps.provedor ? deps.provedor() : clienteAsaasDoAmbiente(process.env).cliente;
            if (!provedor) throw erroAcesso('CONTINUIDADE_INDISPONIVEL', 'O provedor de cobrança não está configurado neste ambiente.', 503);
            const r = await recuperarVinculo(tx, { empresaId, assinaturaId: input.assinaturaId }, provedor);
            await auditarPainel(deps.registrarAuditoria, tx, { ...base, acao: 'COMERCIAL_VINCULO_RECUPERADO', antes: { vinculada: false },
                depois: { assinaturaId: r.assinaturaId, clienteId: r.clienteId } });
            resultado = { assinaturaId: r.assinaturaId };
        }
        else if (input.operacao === 'concluir-continuidade') {
            const r = await concluirContinuidade(tx, { empresaId, continuidadeId: input.continuidadeId, nota: input.motivo, usuarioId: sessao.usuario_id });
            await auditarPainel(deps.registrarAuditoria, tx, { ...base, acao: 'COMERCIAL_CONTINUIDADE_CONCLUIDA', antes: { situacao: 'PENDENTE_PROVEDOR' },
                depois: { continuidadeId: r.continuidadeId, situacao: 'CONCLUIDA', documentoNovo: r.documentoNovo } });
            resultado = { continuidadeId: r.continuidadeId, situacao: 'CONCLUIDA' };
        }
        else {
            const r = await revogarExcecao(tx, { empresaId, excecaoId: input.excecaoId, motivo: input.motivo, usuarioId: sessao.usuario_id });
            await auditarPainel(deps.registrarAuditoria, tx, { ...base, acao: 'COMERCIAL_EXCECAO_REVOGADA', antes: { nivel: antes.nivel, tipo: r.tipo, validaAte: r.validaAte }, depois: { excecaoId: r.excecaoId } });
            resultado = { excecaoId: r.excecaoId };
        }
        return { ...resultado, operacao: input.operacao, comercial: await comercialResumo(tx, empresaId) };
    });
}
