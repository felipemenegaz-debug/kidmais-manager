/**
 * Direito de arrependimento pela mesma ferramenta (grupo C do parecer de apoio, 23/10/2026; migration 097). A Gestão
 * registra a manifestação na tela Assinatura e recebe o protocolo KA-… na hora, INDEPENDENTEMENTE da regra comercial
 * (primeira ativação, garantia de 7 dias) e da disponibilidade do provedor de cobrança: nada aqui chama o provedor. Os
 * dados de prazo e provedor gravados são informativos; quem decide é o atendimento, com registro:
 *   - comunicação ao intermediador (Asaas) — imediata, com referência;
 *   - conclusão RESTITUIDO (valor e referência; encerra o período pago, como o encerramento com devolução da 089) ou
 *     NAO_APLICAVEL (justificativa). Pendências entram na conferência D-C4 (alarme na primeira hora).
 * Confirmação por e-mail ao solicitante e aviso interno [AÇÃO HOJE] à plataforma: melhor esforço, nunca desfazem o registro.
 * O fluxo automático da 089 (ARREPENDIMENTO_7_DIAS, quando elegível) continua; este registro cobre todos os outros casos.
 */
import { randomBytes } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import type { TenantComprovado } from '../saas/provar-tenant.ts';
import type { EnviarEmail, MensagemEmail } from '../acessos/email.ts';
import { erroAcesso } from '../acessos/erros.ts';
import { exigirReautenticacaoRecente } from '../desenvolvedor/autorizacao.ts';
import { configuracaoAsaas } from './asaas.ts';
import { gerarProtocolo } from './devolucao-calculo.ts';
import { canalDaPlataforma } from './devolucao-registro.ts';
import { travarEmpresaComercial } from './ofertas.ts';
import { auditarCobranca } from './sincronizacao-auditoria.ts';

type Ambiente = Record<string, string | undefined>;
const GESTAO = 'REPRESENTANTE_AUTORIZADO';
export const CANAL_OFICIAL = 'contato@demerzellabs.com.br';
export const PROTOCOLO_ARREPENDIMENTO = /^KA-[0-9]{8}-[0-9A-HJKMNP-TV-Z]{8}$/;
const ISO = (c: string) => `to_char((${c}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export type DepsArrependimento = {
    withTenantTransaction: <T>(sessao: SessaoAdmin, empresaSolicitada: string | null | undefined, trabalho: (tx: DbExecutor, tenant: TenantComprovado) => Promise<T>) => Promise<T>;
    withTransaction: <T>(trabalho: (tx: DbExecutor) => Promise<T>) => Promise<T>;
    env?: Ambiente;
    enviarEmail?: EnviarEmail | null;
};
export type Manifestacao = {
    id: string; protocolo: string; canal: 'FERRAMENTA' | 'ATENDIMENTO'; solicitadoEm: string; situacao: 'RECEBIDO' | 'RESTITUIDO' | 'NAO_APLICAVEL';
    dentroDe7Dias: boolean | null; provedorDisponivel: boolean; intermediadorComunicadoEm: string | null; concluidoEm: string | null;
    valorRestituidoCentavos: number | null; emailConfirmacao: string; avisoInterno: string;
};

export async function arrependimentosInstalados(tx: DbExecutor) {
    return (await tx.query<{ ok: boolean }>("SELECT to_regclass('public.assinatura_arrependimentos') IS NOT NULL AS ok")).rows[0]?.ok === true;
}

const COLUNAS = `id, protocolo, canal, ${ISO('solicitado_em')} AS "solicitadoEm", situacao, dentro_de_7_dias AS "dentroDe7Dias", provedor_disponivel AS "provedorDisponivel",
    ${ISO('intermediador_comunicado_em')} AS "intermediadorComunicadoEm", ${ISO('concluido_em')} AS "concluidoEm", valor_restituido_centavos AS "valorRestituidoCentavos",
    email_confirmacao AS "emailConfirmacao", aviso_interno AS "avisoInterno"`;

export async function manifestacoesDaEmpresa(tx: DbExecutor, empresaId: string, limite = 10): Promise<Manifestacao[]> {
    if (!await arrependimentosInstalados(tx)) return [];
    return (await tx.query<Manifestacao>(`SELECT ${COLUNAS} FROM assinatura_arrependimentos WHERE empresa_id = $1::uuid ORDER BY solicitado_em DESC LIMIT $2`,
        [empresaId, limite])).rows;
}

const semId = (m: Manifestacao) => { const c: Partial<Manifestacao> = { ...m }; delete c.id; return c as Omit<Manifestacao, 'id'>; };

/** Tela: instalado e manifestações anteriores (sem id interno). Só a Gestão. */
export async function consultarArrependimento(sessao: SessaoAdmin, empresaSolicitada: string | null | undefined, deps: DepsArrependimento) {
    return deps.withTenantTransaction(sessao, empresaSolicitada, async (tx, tenant) => {
        if (tenant.papelAtual !== GESTAO) throw erroAcesso('COBRANCA_SEM_PERMISSAO', 'Somente a Gestão desta empresa registra o arrependimento.', 403);
        const instalado = await arrependimentosInstalados(tx);
        return { instalado, canalOficial: CANAL_OFICIAL, manifestacoes: instalado ? (await manifestacoesDaEmpresa(tx, tenant.empresaComprovada)).map(semId) : [] };
    });
}

function chaveValida(v: unknown) {
    if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v))
        throw erroAcesso('DADOS_INVALIDOS', 'Atualize a página e tente de novo.', 400, { campo: 'chave' });
    return v.toLowerCase();
}

async function inserirComProtocolo(tx: DbExecutor, valores: unknown[]): Promise<Manifestacao> {
    for (let tentativa = 0; tentativa < 2; tentativa++) {
        const protocolo = gerarProtocolo(Date.now(), randomBytes(8)).replace(/^KM-/, 'KA-');
        if (!PROTOCOLO_ARREPENDIMENTO.test(protocolo)) throw new Error('Protocolo inválido.');
        await tx.query('SAVEPOINT kidmais_097_protocolo');
        try {
            const r = (await tx.query<Manifestacao>(`INSERT INTO assinatura_arrependimentos (protocolo, empresa_id, chave_idempotencia, canal, solicitado_por, motivo,
                    situacao_assinatura, contratado_em, dentro_de_7_dias, provedor_disponivel)
                VALUES ($1, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8::timestamptz, $9, $10) RETURNING ${COLUNAS}`, [protocolo, ...valores])).rows[0];
            await tx.query('RELEASE SAVEPOINT kidmais_097_protocolo');
            return r;
        }
        catch (error) {
            await tx.query('ROLLBACK TO SAVEPOINT kidmais_097_protocolo');
            const colisao = (error as { code?: string; constraint?: string }).code === '23505' && (error as { constraint?: string }).constraint === 'assinatura_arrependimentos_protocolo_key';
            if (!colisao || tentativa === 1) throw error;
        }
    }
    throw new Error('Protocolo não gerado.');
}

/**
 * Registro da manifestação pela Gestão (senha confirmada há ≤ 5 min). Idempotente pela chave. Não chama o provedor e
 * não depende de elegibilidade: qualquer assinatura existente da empresa aceita o registro.
 */
export async function registrarArrependimento(sessao: SessaoAdmin, empresaSolicitada: string | null | undefined, raw: unknown,
    ctx: { requestId: string; ip?: string | null }, deps: DepsArrependimento) {
    const env = deps.env ?? process.env;
    const corpo = (raw ?? {}) as { chave?: unknown; confirmar?: unknown; motivo?: unknown };
    if (corpo.confirmar !== true) throw erroAcesso('DADOS_INVALIDOS', 'Confirme que deseja desistir da contratação.', 400, { campo: 'confirmar' });
    const chave = chaveValida(corpo.chave);
    const motivo = typeof corpo.motivo === 'string' ? corpo.motivo.trim().slice(0, 500) : '';
    exigirReautenticacaoRecente(sessao);
    const r = await deps.withTenantTransaction(sessao, empresaSolicitada, async (tx, tenant) => {
        if (tenant.papelAtual !== GESTAO) throw erroAcesso('COBRANCA_SEM_PERMISSAO', 'Somente a Gestão desta empresa registra o arrependimento.', 403);
        if (!await arrependimentosInstalados(tx))
            throw erroAcesso('ARREPENDIMENTO_INDISPONIVEL', `O registro pela tela ainda não está disponível neste ambiente. Envie o pedido de arrependimento para ${CANAL_OFICIAL}: ele vale a partir do envio.`, 503);
        const empresaId = tenant.empresaComprovada;
        const anterior = (await tx.query<Manifestacao>(`SELECT ${COLUNAS} FROM assinatura_arrependimentos WHERE empresa_id = $1::uuid AND chave_idempotencia = $2::uuid`,
            [empresaId, chave])).rows[0];
        if (anterior) return { m: anterior, repetido: true, para: null as string | null, nome: '' };
        await travarEmpresaComercial(tx, empresaId);
        const a = (await tx.query<{ situacao: string; contratado_em: string | null; dentro: boolean | null; nome: string }>(`SELECT a.situacao, e.nome,
                ${ISO('ref.contratado_em')} AS contratado_em, (ref.contratado_em >= clock_timestamp() - interval '7 days') AS dentro
              FROM empresa_assinaturas a JOIN empresas e ON e.id = a.empresa_id
              LEFT JOIN LATERAL (SELECT max(confirmada_em) AS contratado_em FROM assinatura_contratacoes c WHERE c.empresa_id = a.empresa_id AND c.estado = 'CONFIRMADA') ref ON true
             WHERE a.empresa_id = $1::uuid`, [empresaId])).rows[0];
        if (!a) throw erroAcesso('CONFLITO', 'Esta empresa não tem assinatura registrada no Kidmais Manager.', 409);
        const m = await inserirComProtocolo(tx, [empresaId, chave, 'FERRAMENTA', sessao.usuario_id, motivo || null, a.situacao, a.contratado_em, a.dentro, configuracaoAsaas(env).ligado]);
        await auditarCobranca(tx, { acao: 'ARREPENDIMENTO_REGISTRADO', empresaId, origem: { tipo: 'GESTAO', usuarioId: sessao.usuario_id, requestId: ctx.requestId },
            ip: ctx.ip ?? null, justificativa: motivo || null, depois: { protocolo: m.protocolo, canal: 'FERRAMENTA', situacaoAssinatura: a.situacao } });
        const para = (await tx.query<{ email: string | null }>('SELECT email FROM usuarios_administrativos WHERE id = $1::uuid', [sessao.usuario_id])).rows[0]?.email ?? null;
        return { m, repetido: false, para, nome: a.nome };
    });
    let m = r.m;
    if (!r.repetido) {
        m = { ...m, emailConfirmacao: await enviarConfirmacaoArrependimento(deps, m, r.para, r.nome) };
        m = { ...m, avisoInterno: await enviarAvisoArrependimento(deps, m) };
    }
    return { ...semId(m), repetido: r.repetido };
}

const horaBr = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
const escapar = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const mensagem = (para: string, assunto: string, linhas: string[], idempotencia: string): MensagemEmail => ({ para, assunto, texto: linhas.join('\n\n'),
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">${linhas.map((l) => `<p>${escapar(l)}</p>`).join('')}</div>`, idempotencia });

export function mensagemConfirmacaoArrependimento(para: string, empresa: string, m: Pick<Manifestacao, 'protocolo' | 'solicitadoEm'>): MensagemEmail {
    return mensagem(para, `Kidmais Manager — arrependimento registrado, protocolo ${m.protocolo}`, [
        `Recebemos o seu pedido de arrependimento da contratação do Kidmais Manager${empresa ? ` (${empresa})` : ''}.`,
        `Protocolo: ${m.protocolo}. Registrado em ${horaBr(m.solicitadoEm)} (horário de Brasília).`,
        'Vamos providenciar a restituição dos valores pagos e a comunicação ao intermediador de pagamento imediatamente, e informar o andamento por este e-mail. O prazo do crédito depende do meio de pagamento.',
        `Dúvidas: ${CANAL_OFICIAL}, informando o protocolo.`,
    ], `arrependimento:${m.protocolo}`);
}

async function registrarSituacao(deps: DepsArrependimento, protocolo: string, coluna: 'email_confirmacao' | 'aviso_interno', situacao: string) {
    try {
        await deps.withTransaction((tx) => tx.query(`UPDATE assinatura_arrependimentos SET ${coluna} = $2 WHERE protocolo = $1 AND ${coluna} = 'PENDENTE'`, [protocolo, situacao]));
    }
    catch (error) { console.error('[assinatura] situação do e-mail de arrependimento não gravada', error instanceof Error ? error.name : typeof error); }
}

async function enviarConfirmacaoArrependimento(deps: DepsArrependimento, m: Manifestacao, para: string | null, empresa: string) {
    if (!deps.enviarEmail) return m.emailConfirmacao;
    let situacao: 'ENVIADO' | 'FALHOU' | 'SEM_DESTINATARIO' = 'SEM_DESTINATARIO';
    if (para) {
        try { await deps.enviarEmail(mensagemConfirmacaoArrependimento(para, empresa, m)); situacao = 'ENVIADO'; }
        catch { situacao = 'FALHOU'; }
    }
    await registrarSituacao(deps, m.protocolo, 'email_confirmacao', situacao);
    return situacao;
}

/** Aviso interno imediato: só protocolo, canal, informativos e instrução; sem nome, pessoa, e-mail ou documento. */
export function mensagemAvisoArrependimento(para: string, m: Pick<Manifestacao, 'protocolo' | 'solicitadoEm' | 'dentroDe7Dias' | 'provedorDisponivel'>): MensagemEmail {
    return mensagem(para, `[AÇÃO HOJE] Kidmais Manager — arrependimento ${m.protocolo}`, [
        `Manifestação de arrependimento registrada na tela Assinatura. Protocolo: ${m.protocolo}. Em ${horaBr(m.solicitadoEm)} (Brasília).`,
        `Informativo (não decide): ${m.dentroDe7Dias === null ? 'sem data de contratação confirmada' : m.dentroDe7Dias ? 'dentro de 7 dias da última contratação confirmada' : 'mais de 7 dias da última contratação confirmada'}; provedor ${m.provedorDisponivel ? 'configurado' : 'indisponível neste ambiente'}.`,
        'Prazo: IMEDIATO. Comunicar o intermediador (Asaas) e restituir os valores pagos, ou registrar por que não se aplica, no painel do desenvolvedor (situação comercial da empresa), localizando pelo protocolo.',
    ], `arrependimento-interno:${m.protocolo}`);
}

async function enviarAvisoArrependimento(deps: DepsArrependimento, m: Manifestacao) {
    if (!deps.enviarEmail) return m.avisoInterno;
    const para = canalDaPlataforma(deps.env ?? process.env);
    let situacao: 'ENVIADO' | 'FALHOU' | 'NAO_CONFIGURADO' = 'NAO_CONFIGURADO';
    if (para) {
        try { await deps.enviarEmail(mensagemAvisoArrependimento(para, m)); situacao = 'ENVIADO'; }
        catch (error) { situacao = (error as { code?: string }).code === 'EMAIL_NAO_CONFIGURADO' ? 'NAO_CONFIGURADO' : 'FALHOU'; }
    }
    await registrarSituacao(deps, m.protocolo, 'aviso_interno', situacao);
    return situacao;
}

// ---------------------------------------------------------------------------------------------------------------------
// Atendimento (painel do desenvolvedor): comunicação ao intermediador e conclusão, com registro e auditoria.
// ---------------------------------------------------------------------------------------------------------------------

export async function registrarComunicacaoIntermediador(tx: DbExecutor, input: { empresaId: string; protocolo: string; referencia: string }) {
    if (!await arrependimentosInstalados(tx)) throw erroAcesso('ARREPENDIMENTO_INDISPONIVEL', 'A 097 não está instalada neste ambiente.', 503);
    const r = (await tx.query<{ protocolo: string }>(`UPDATE assinatura_arrependimentos SET intermediador_comunicado_em = clock_timestamp(), intermediador_referencia = $3
        WHERE empresa_id = $1::uuid AND protocolo = $2 AND intermediador_comunicado_em IS NULL AND situacao = 'RECEBIDO' RETURNING protocolo`,
        [input.empresaId, input.protocolo, input.referencia.trim()])).rows[0];
    if (!r) throw erroAcesso('CONFLITO', 'Não há manifestação aberta sem comunicação com este protocolo nesta empresa.', 409);
    return r;
}

/**
 * Conclusão pelo atendimento. RESTITUIDO exige a comunicação já registrada, valor e referência, e encerra o período pago
 * (ATIVA/EM_ATRASO/CANCELADA_FIM_PERIODO → ENCERRADA; 60 dias de somente leitura). NAO_APLICAVEL exige justificativa e não
 * muda o acesso.
 */
export async function concluirArrependimento(tx: DbExecutor, input: { empresaId: string; protocolo: string; usuarioId: string; situacao: 'RESTITUIDO' | 'NAO_APLICAVEL';
    referencia: string; valorCentavos?: number | null }) {
    if (!await arrependimentosInstalados(tx)) throw erroAcesso('ARREPENDIMENTO_INDISPONIVEL', 'A 097 não está instalada neste ambiente.', 503);
    if (input.situacao === 'RESTITUIDO' && !(Number.isSafeInteger(input.valorCentavos) && (input.valorCentavos ?? 0) > 0))
        throw erroAcesso('DADOS_INVALIDOS', 'Informe o valor restituído.', 400, { campo: 'valorCentavos' });
    await travarEmpresaComercial(tx, input.empresaId);
    const m = (await tx.query<{ intermediador: boolean }>(`SELECT intermediador_comunicado_em IS NOT NULL AS intermediador FROM assinatura_arrependimentos
        WHERE empresa_id = $1::uuid AND protocolo = $2 AND situacao = 'RECEBIDO' FOR UPDATE`, [input.empresaId, input.protocolo])).rows[0];
    if (!m) throw erroAcesso('CONFLITO', 'Não há manifestação aberta com este protocolo nesta empresa.', 409);
    if (input.situacao === 'RESTITUIDO' && !m.intermediador)
        throw erroAcesso('CONFLITO', 'Registre antes a comunicação ao intermediador.', 409);
    await tx.query(`UPDATE assinatura_arrependimentos SET situacao = $3, concluido_em = clock_timestamp(), concluido_por = $4::uuid, conclusao_referencia = $5,
        valor_restituido_centavos = $6 WHERE empresa_id = $1::uuid AND protocolo = $2`,
        [input.empresaId, input.protocolo, input.situacao, input.usuarioId, input.referencia.trim(), input.situacao === 'RESTITUIDO' ? input.valorCentavos : null]);
    let encerrou = false;
    if (input.situacao === 'RESTITUIDO')
        encerrou = (await tx.query(`UPDATE empresa_assinaturas SET situacao = 'ENCERRADA', encerrada_em = clock_timestamp(), periodo_atual_fim = clock_timestamp(),
                cancelada_em = COALESCE(cancelada_em, clock_timestamp()), em_atraso_desde = NULL
            WHERE empresa_id = $1::uuid AND situacao IN ('ATIVA', 'EM_ATRASO', 'CANCELADA_FIM_PERIODO')`, [input.empresaId])).rowCount === 1;
    return { protocolo: input.protocolo, situacao: input.situacao, encerrou };
}
