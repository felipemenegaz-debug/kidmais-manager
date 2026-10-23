/**
 * Direito de arrependimento pela mesma ferramenta (grupo C do parecer de apoio, 23/10/2026; migration 097). A Gestão
 * registra a manifestação na tela Assinatura e recebe o protocolo KA-… na hora, INDEPENDENTEMENTE da regra comercial
 * (primeira ativação, garantia de 7 dias) e da disponibilidade do provedor de cobrança: nada aqui chama o provedor. Os
 * dados de prazo e provedor gravados são informativos; quem decide é o atendimento, com registro:
 *   - comunicação ao intermediador (Asaas) — imediata, com referência;
 *   - conclusão RESTITUIDO (valor e referência; encerra o período pago, como o encerramento com devolução da 089, se a
 *     empresa ainda estiver na assinatura do provedor do registro) ou NAO_APLICAVEL (justificativa). A restituição grava o
 *     limite: a sincronização não deixa as cobranças daquela assinatura até ele reabrirem o período (P2-C1).
 *   Pendências: vigia de 15 min (scripts/arrependimento-vigia.cjs, alarme imediato com aviso interno falho) e D-C4 diária.
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
import { configuracaoAsaas, type AssinaturaProvedor } from './asaas.ts';
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
    valorRestituidoCentavos: number | null; emailConfirmacao: string; avisoInterno: string; emailConclusao: string | null;
};

export async function arrependimentosInstalados(tx: DbExecutor) {
    return (await tx.query<{ ok: boolean }>("SELECT to_regclass('public.assinatura_arrependimentos') IS NOT NULL AS ok")).rows[0]?.ok === true;
}

const COLUNAS = `id, protocolo, canal, ${ISO('solicitado_em')} AS "solicitadoEm", situacao, dentro_de_7_dias AS "dentroDe7Dias", provedor_disponivel AS "provedorDisponivel",
    ${ISO('intermediador_comunicado_em')} AS "intermediadorComunicadoEm", ${ISO('concluido_em')} AS "concluidoEm", valor_restituido_centavos AS "valorRestituidoCentavos",
    email_confirmacao AS "emailConfirmacao", aviso_interno AS "avisoInterno", email_conclusao AS "emailConclusao"`;

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
                    situacao_assinatura, contratado_em, dentro_de_7_dias, provedor_disponivel, provedor_assinatura_id, solicitado_em)
                VALUES ($1, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8::timestamptz, $9, $10, $11, coalesce($12::timestamptz, clock_timestamp())) RETURNING ${COLUNAS}`,
                [protocolo, ...valores, ...(valores.length === 10 ? [null] : [])])).rows[0];
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
        const a = (await tx.query<{ situacao: string; contratado_em: string | null; dentro: boolean | null; nome: string; assinatura: string | null }>(`SELECT a.situacao, e.nome,
                a.provedor_assinatura_id AS assinatura,
                ${ISO('ref.contratado_em')} AS contratado_em, (ref.contratado_em >= clock_timestamp() - interval '7 days') AS dentro
              FROM empresa_assinaturas a JOIN empresas e ON e.id = a.empresa_id
              LEFT JOIN LATERAL (SELECT max(confirmada_em) AS contratado_em FROM assinatura_contratacoes c WHERE c.empresa_id = a.empresa_id AND c.estado = 'CONFIRMADA') ref ON true
             WHERE a.empresa_id = $1::uuid`, [empresaId])).rows[0];
        if (!a) throw erroAcesso('CONFLITO', 'Esta empresa não tem assinatura registrada no Kidmais Manager.', 409);
        const m = await inserirComProtocolo(tx, [empresaId, chave, 'FERRAMENTA', sessao.usuario_id, motivo || null, a.situacao, a.contratado_em, a.dentro, configuracaoAsaas(env).ligado, a.assinatura]);
        await auditarCobranca(tx, { acao: 'ARREPENDIMENTO_REGISTRADO', empresaId, origem: { tipo: 'GESTAO', usuarioId: sessao.usuario_id, requestId: ctx.requestId },
            ip: ctx.ip ?? null, justificativa: motivo || null, depois: { protocolo: m.protocolo, canal: 'FERRAMENTA', situacaoAssinatura: a.situacao } });
        const para = (await tx.query<{ email: string | null }>('SELECT email FROM usuarios_administrativos WHERE id = $1::uuid', [sessao.usuario_id])).rows[0]?.email ?? null;
        return { m, repetido: false, para, nome: a.nome };
    });
    let m = r.m;
    if (!r.repetido) m = { ...m, ...await notificarRegistro(deps, r) };
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
        'Este e-mail confirma o registro do pedido. A equipe Kidmais vai analisá-lo e, quando cabível, comunicar o intermediador de pagamento e providenciar a restituição dos valores pagos, informando o resultado pelo canal oficial. O prazo do crédito depende do meio de pagamento.',
        `Dúvidas: ${CANAL_OFICIAL}, informando o protocolo.`,
    ], `arrependimento:${m.protocolo}`);
}

type DepsNotificacao = Pick<DepsArrependimento, 'withTransaction' | 'env' | 'enviarEmail'>;
async function registrarSituacao(deps: DepsNotificacao, protocolo: string, coluna: 'email_confirmacao' | 'aviso_interno' | 'email_conclusao', situacao: string) {
    try {
        const pendente = coluna === 'email_conclusao' ? 'IS NULL' : "= 'PENDENTE'";
        await deps.withTransaction((tx) => tx.query(`UPDATE assinatura_arrependimentos SET ${coluna} = $2 WHERE protocolo = $1 AND ${coluna} ${pendente}`, [protocolo, situacao]));
    }
    catch (error) { console.error('[assinatura] situação do e-mail de arrependimento não gravada', error instanceof Error ? error.name : typeof error); }
}

async function enviarConfirmacaoArrependimento(deps: DepsNotificacao, m: Manifestacao, para: string | null, empresa: string) {
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

async function enviarAvisoArrependimento(deps: DepsNotificacao, m: Manifestacao) {
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

/** Depois do COMMIT do registro: confirmação ao solicitante e aviso interno (melhor esforço; a situação fica gravada). */
export async function notificarRegistro(deps: DepsNotificacao, r: { m: Manifestacao; para: string | null; nome: string }) {
    const emailConfirmacao = await enviarConfirmacaoArrependimento(deps, r.m, r.para, r.nome);
    const avisoInterno = await enviarAvisoArrependimento(deps, { ...r.m, emailConfirmacao });
    return { emailConfirmacao, avisoInterno };
}

// ---------------------------------------------------------------------------------------------------------------------
// Atendimento (painel do desenvolvedor): registro de pedido recebido pelo canal oficial, comunicação ao intermediador e
// conclusão, com registro e auditoria.

/**
 * Pedido recebido pelo canal oficial (e-mail), registrado pelo atendimento (23/10/2026; antes só por SQL). Mesmo registro
 * da tela, canal ATENDIMENTO: protocolo KA-, data REAL do recebimento (não a do lançamento), solicitante = pessoa da
 * Gestão ativa desta empresa cujo e-mail enviou o pedido (outro remetente: recusa — confirmar a identidade antes),
 * idempotente pela chave, auditoria, e depois do COMMIT confirmação ao solicitante e aviso interno (notificarRegistro).
 * Não chama o provedor e não depende de elegibilidade, como o registro pela tela.
 */
export async function registrarArrependimentoAtendimento(tx: DbExecutor, input: { empresaId: string; atendenteId: string; chave: string;
    emailSolicitante: string; recebidoEm: string; referencia: string; requestId?: string | null }, env: Ambiente = process.env) {
    const chave = chaveValida(input.chave);
    const email = input.emailSolicitante.trim().toLowerCase();
    if (!/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(email)) throw erroAcesso('DADOS_INVALIDOS', 'Informe o e-mail de quem enviou o pedido.', 400, { campo: 'emailSolicitante' });
    const referencia = input.referencia.trim();
    if (referencia.length < 5 || referencia.length > 400) throw erroAcesso('DADOS_INVALIDOS', 'Descreva a mensagem recebida (assunto, data e hora), de 5 a 400 caracteres.', 400, { campo: 'referencia' });
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(input.recebidoEm) || Number.isNaN(Date.parse(input.recebidoEm)))
        throw erroAcesso('DADOS_INVALIDOS', 'Informe a data e a hora em que o pedido foi recebido.', 400, { campo: 'recebidoEm' });
    if (!await arrependimentosInstalados(tx)) throw erroAcesso('ARREPENDIMENTO_INDISPONIVEL', 'A 097 não está instalada neste ambiente.', 503);
    const anterior = (await tx.query<Manifestacao>(`SELECT ${COLUNAS} FROM assinatura_arrependimentos WHERE empresa_id = $1::uuid AND chave_idempotencia = $2::uuid`,
        [input.empresaId, chave])).rows[0];
    if (anterior) return { m: anterior, repetido: true, para: null as string | null, nome: '' };
    await travarEmpresaComercial(tx, input.empresaId);
    // Revisão 2765be2 (P2-N6): o pedido é do RECEBIMENTO, não do lançamento. A assinatura atual só vira o vínculo do pedido
    // se já valia no recebimento — prova: contratação CONFIRMADA dessa assinatura com confirmação até o recebimento (como ela
    // continua atual, não foi trocada depois). Sem essa prova (recontratação depois do recebimento, vínculo legado sem
    // contratação), o pedido fica SEM vínculo e a conclusão usa a resolução assistida (assinatura informada + prova).
    const a = (await tx.query<{ situacao: string; contratado_em: string | null; dentro: boolean | null; nome: string; assinatura: string | null; valido: boolean }>(`SELECT a.situacao, e.nome,
            CASE WHEN a.provedor_assinatura_id IS NOT NULL AND EXISTS (SELECT 1 FROM assinatura_contratacoes v WHERE v.empresa_id = a.empresa_id
                AND v.estado = 'CONFIRMADA' AND v.provedor_assinatura_id = a.provedor_assinatura_id AND v.confirmada_em <= $2::timestamptz)
              THEN a.provedor_assinatura_id END AS assinatura,
            ${ISO('ref.contratado_em')} AS contratado_em, (ref.contratado_em >= $2::timestamptz - interval '7 days') AS dentro,
            ($2::timestamptz <= clock_timestamp() AND $2::timestamptz >= a.criado_em AND $2::timestamptz >= clock_timestamp() - interval '90 days') AS valido
          FROM empresa_assinaturas a JOIN empresas e ON e.id = a.empresa_id
          LEFT JOIN LATERAL (SELECT max(confirmada_em) AS contratado_em FROM assinatura_contratacoes c WHERE c.empresa_id = a.empresa_id AND c.estado = 'CONFIRMADA'
            AND c.confirmada_em <= $2::timestamptz) ref ON true
         WHERE a.empresa_id = $1::uuid`, [input.empresaId, input.recebidoEm])).rows[0];
    if (!a) throw erroAcesso('CONFLITO', 'Esta empresa não tem assinatura registrada no Kidmais Manager.', 409);
    if (!a.valido) throw erroAcesso('DADOS_INVALIDOS', 'A data do recebimento precisa estar entre a criação da assinatura e agora (até 90 dias atrás).', 400, { campo: 'recebidoEm' });
    const solicitante = (await tx.query<{ id: string; email: string }>(`SELECT u.id, u.email FROM memberships m JOIN usuarios_administrativos u ON u.id = m.usuario_id
        WHERE m.empresa_id = $1::uuid AND m.status = 'ATIVA' AND m.papel = $2 AND u.ativo AND lower(u.email) = $3 LIMIT 1`, [input.empresaId, GESTAO, email])).rows[0];
    if (!solicitante)
        throw erroAcesso('CONFLITO', 'O e-mail não é de uma pessoa da Gestão ativa desta empresa. Confirme a identidade de quem pediu pelo canal oficial antes de registrar.', 409, { campo: 'emailSolicitante' });
    const motivo = `Recebido pelo canal oficial: ${referencia}`.slice(0, 500);
    const m = await inserirComProtocolo(tx, [input.empresaId, chave, 'ATENDIMENTO', solicitante.id, motivo, a.situacao, a.contratado_em, a.dentro,
        configuracaoAsaas(env).ligado, a.assinatura, input.recebidoEm]);
    await auditarCobranca(tx, { acao: 'ARREPENDIMENTO_REGISTRADO', empresaId: input.empresaId, origem: { tipo: 'DESENVOLVEDOR', usuarioId: input.atendenteId, requestId: input.requestId ?? null },
        justificativa: motivo, depois: { protocolo: m.protocolo, canal: 'ATENDIMENTO', situacaoAssinatura: a.situacao, recebidoEm: m.solicitadoEm } });
    return { m, repetido: false, para: solicitante.email, nome: a.nome };
}
// ---------------------------------------------------------------------------------------------------------------------

const reais = (centavos: number) => (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Resultado da conclusão ao contratante. Restituição: valor (sem referência interna). Não se aplica: a justificativa. */
/**
 * Situação observada no envio (revisões 2765be2 P3-N1 e 939c90f P3-R1): o e-mail não promete estado que não houve. É a
 * situação lida no momento do envio, não o efeito histórico da conclusão; por isso o texto fala do pedido e da contratação
 * restituída, e na contratação atual diz só que este pedido não a altera (sem afirmar que está ativa ou com acesso completo).
 */
export type EfeitoConclusao = 'ENCERRADO' | 'CONTRATACAO_ATUAL_MANTIDA' | 'SEM_ALTERACAO';
export function mensagemConclusaoArrependimento(para: string, empresa: string, d: { protocolo: string; situacao: 'RESTITUIDO' | 'NAO_APLICAVEL';
    valorRestituidoCentavos: number | null; justificativa: string | null; efeito?: EfeitoConclusao }): MensagemEmail {
    const efeito = d.efeito === 'ENCERRADO'
        ? ['O período contratado foi encerrado; a área do sistema fica disponível em somente leitura pelo prazo informado nos Termos, com exportação dos dados.']
        : d.efeito === 'CONTRATACAO_ATUAL_MANTIDA' ? ['Este pedido se refere à contratação anterior e não altera a sua contratação atual.'] : [];
    const linhas = d.situacao === 'RESTITUIDO' ? [
        `Concluímos o seu pedido de arrependimento da contratação do Kidmais Manager${empresa ? ` (${empresa})` : ''}, protocolo ${d.protocolo}.`,
        `A restituição de ${reais(d.valorRestituidoCentavos ?? 0)} foi solicitada ao intermediador de pagamento. O prazo do crédito depende do meio de pagamento.`,
        ...efeito,
        `Dúvidas: ${CANAL_OFICIAL}, informando o protocolo.`,
    ] : [
        `Analisamos o seu pedido de arrependimento da contratação do Kidmais Manager${empresa ? ` (${empresa})` : ''}, protocolo ${d.protocolo}.`,
        `Resultado: não se aplica. Motivo: ${d.justificativa ?? ''}`,
        `Se discordar ou tiver dúvidas, responda pelo canal oficial ${CANAL_OFICIAL}, informando o protocolo.`,
    ];
    return mensagem(para, `Kidmais Manager — resultado do pedido de arrependimento, protocolo ${d.protocolo}`, linhas, `arrependimento-conclusao:${d.protocolo}`);
}

/**
 * Depois do COMMIT da conclusão: e-mail ao solicitante com o resultado; a situação (ENVIADO / FALHOU / SEM_DESTINATARIO)
 * fica gravada uma vez em email_conclusao (evidência da comunicação; nunca desfaz a conclusão).
 */
export async function enviarEmailConclusao(deps: DepsNotificacao, empresaId: string, protocolo: string): Promise<string | null> {
    try {
        const d = (await deps.withTransaction((tx) => tx.query<{ situacao: 'RECEBIDO' | 'RESTITUIDO' | 'NAO_APLICAVEL'; valor: number | null; justificativa: string | null;
                email_conclusao: string | null; para: string | null; nome: string; efeito: EfeitoConclusao }>(`SELECT r.situacao, r.valor_restituido_centavos AS valor,
                r.conclusao_referencia AS justificativa, r.email_conclusao, u.email AS para, e.nome,
                CASE WHEN coalesce(r.provedor_assinatura_id, r.restituicao_assinatura_id) IS NOT NULL
                       AND coalesce(r.provedor_assinatura_id, r.restituicao_assinatura_id) = a.provedor_assinatura_id AND a.situacao = 'ENCERRADA' THEN 'ENCERRADO'
                     WHEN coalesce(r.provedor_assinatura_id, r.restituicao_assinatura_id) IS DISTINCT FROM a.provedor_assinatura_id
                       AND a.situacao IN ('ATIVA', 'EM_ATRASO', 'CANCELADA_FIM_PERIODO') THEN 'CONTRATACAO_ATUAL_MANTIDA'
                     ELSE 'SEM_ALTERACAO' END AS efeito
              FROM assinatura_arrependimentos r JOIN empresas e ON e.id = r.empresa_id JOIN empresa_assinaturas a ON a.empresa_id = r.empresa_id
              LEFT JOIN usuarios_administrativos u ON u.id = r.solicitado_por
             WHERE r.empresa_id = $1::uuid AND r.protocolo = $2`, [empresaId, protocolo]))).rows[0];
        if (!d || d.situacao === 'RECEBIDO' || d.email_conclusao !== null) return d?.email_conclusao ?? null;
        if (!deps.enviarEmail) return null;
        let situacao: 'ENVIADO' | 'FALHOU' | 'SEM_DESTINATARIO' = 'SEM_DESTINATARIO';
        if (d.para) {
            try {
                await deps.enviarEmail(mensagemConclusaoArrependimento(d.para, d.nome, { protocolo, situacao: d.situacao, valorRestituidoCentavos: d.valor,
                    justificativa: d.situacao === 'NAO_APLICAVEL' ? d.justificativa : null, efeito: d.situacao === 'RESTITUIDO' ? d.efeito : undefined }));
                situacao = 'ENVIADO';
            }
            catch { situacao = 'FALHOU'; }
        }
        await registrarSituacao(deps, protocolo, 'email_conclusao', situacao);
        return situacao;
    }
    catch (error) {
        console.error('[assinatura] e-mail de conclusão do arrependimento não registrado', error instanceof Error ? error.name : typeof error);
        return null;
    }
}

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
/** Evidência de que a assinatura restituída é desta empresa (revisão 5a129de, P2-N3). */
export type EvidenciaAssinatura = 'REGISTRO' | 'ATUAL' | 'CONTRATACAO' | 'ENCERRAMENTO' | 'PROVEDOR';
export type ProvedorConferencia = { obterAssinatura(id: string): Promise<AssinaturaProvedor | null> };

/**
 * Fontes locais de TITULARIDADE (revisão f6b6fbb, P2-N4): só vínculos gravados depois da conferência de isolamento —
 * assinatura atual (vínculo da empresa), contratação CONFIRMADA (gravada pela sincronização da assinatura desta empresa,
 * depois de conferir referência externa e cliente) e pedido da 089 (cópia do vínculo da empresa). O evento de cobrança
 * NÃO entra: o empresa_id dele pode vir só da referência de roteamento, sem provar de quem é a assinatura do evento.
 * Tabelas opcionais (074a, 089) só entram na consulta quando existem (P2-N5: o PostgreSQL resolve os nomes antes do AND).
 */
const FONTES_LOCAIS: readonly { evidencia: EvidenciaAssinatura; tabela: string | null; sql: string }[] = [
    { evidencia: 'ATUAL', tabela: null, sql: 'SELECT 1 FROM empresa_assinaturas WHERE empresa_id = $1::uuid AND provedor_assinatura_id = $2' },
    { evidencia: 'CONTRATACAO', tabela: 'assinatura_contratacoes',
        sql: "SELECT 1 FROM assinatura_contratacoes WHERE empresa_id = $1::uuid AND provedor_assinatura_id = $2 AND estado = 'CONFIRMADA'" },
    { evidencia: 'ENCERRAMENTO', tabela: 'assinatura_encerramentos', sql: 'SELECT 1 FROM assinatura_encerramentos WHERE empresa_id = $1::uuid AND provedor_assinatura_id = $2' },
];

/**
 * Prova de pertinência da assinatura informada pelo atendimento: primeiro as fontes locais de titularidade, na ordem; sem
 * elas, a leitura da assinatura no provedor com a referência externa desta empresa. Sem prova: null (conclusão recusada).
 */
export async function evidenciaDaAssinatura(tx: DbExecutor, empresaId: string, assinaturaId: string, provedor?: ProvedorConferencia | null): Promise<EvidenciaAssinatura | null> {
    const opcionais = FONTES_LOCAIS.flatMap((f) => (f.tabela ? [f.tabela] : []));
    const existentes = new Set((await tx.query<{ t: string }>(
        "SELECT t FROM unnest($1::text[]) AS t WHERE to_regclass('public.' || t) IS NOT NULL", [opcionais])).rows.map((l) => l.t));
    for (const f of FONTES_LOCAIS) {
        if (f.tabela && !existentes.has(f.tabela)) continue;
        if ((await tx.query(f.sql, [empresaId, assinaturaId])).rows.length > 0) return f.evidencia;
    }
    if (!provedor) return null;
    const remota = await provedor.obterAssinatura(assinaturaId);
    return remota && remota.id === assinaturaId && remota.externalReference === empresaId ? 'PROVEDOR' : null;
}

export async function concluirArrependimento(tx: DbExecutor, input: { empresaId: string; protocolo: string; usuarioId: string; situacao: 'RESTITUIDO' | 'NAO_APLICAVEL';
    referencia: string; valorCentavos?: number | null; cobrancaIds?: readonly string[] | null; assinaturaId?: string | null }, provedor?: ProvedorConferencia | null) {
    if (!await arrependimentosInstalados(tx)) throw erroAcesso('ARREPENDIMENTO_INDISPONIVEL', 'A 097 não está instalada neste ambiente.', 503);
    if (input.situacao === 'RESTITUIDO' && !(Number.isSafeInteger(input.valorCentavos) && (input.valorCentavos ?? 0) > 0))
        throw erroAcesso('DADOS_INVALIDOS', 'Informe o valor restituído.', 400, { campo: 'valorCentavos' });
    await travarEmpresaComercial(tx, input.empresaId);
    const ID = /^[A-Za-z0-9_-]{1,100}$/;
    const restituido = input.situacao === 'RESTITUIDO';
    // Revisão d72d8b8 (P2-N2): a restituição identifica as cobranças restituídas (ao menos uma); nada é inferido só do
    // vencimento.
    const cobrancas = restituido ? [...new Set((input.cobrancaIds ?? []).map((c) => c.trim()).filter(Boolean))] : [];
    if (restituido && (cobrancas.length === 0 || cobrancas.length > 50 || !cobrancas.every((c) => ID.test(c))))
        throw erroAcesso('DADOS_INVALIDOS', 'Informe as cobranças restituídas no Asaas (pay_…), ao menos uma.', 400, { campo: 'cobrancaIds' });
    if (input.assinaturaId != null && !ID.test(input.assinaturaId))
        throw erroAcesso('DADOS_INVALIDOS', 'Identificador da assinatura inválido.', 400, { campo: 'assinaturaId' });
    const m = (await tx.query<{ intermediador: boolean; assinatura: string | null; atual: string | null }>(`SELECT r.intermediador_comunicado_em IS NOT NULL AS intermediador,
            r.provedor_assinatura_id AS assinatura, a.provedor_assinatura_id AS atual
          FROM assinatura_arrependimentos r JOIN empresa_assinaturas a ON a.empresa_id = r.empresa_id
         WHERE r.empresa_id = $1::uuid AND r.protocolo = $2 AND r.situacao = 'RECEBIDO' FOR UPDATE OF r`, [input.empresaId, input.protocolo])).rows[0];
    if (!m) throw erroAcesso('CONFLITO', 'Não há manifestação aberta com este protocolo nesta empresa.', 409);
    if (input.situacao === 'RESTITUIDO' && !m.intermediador)
        throw erroAcesso('CONFLITO', 'Registre antes a comunicação ao intermediador.', 409);
    // Assinatura restituída (P2-N1/P2-N3) ≠ assinatura atual. Com vínculo no registro, é a dele (informada diferente: recusa).
    // Sem vínculo no registro, o atendimento SEMPRE informa a assinatura restituída — a atual ou uma anterior (recontratação
    // depois do pedido) —, aceita só com prova de que é desta empresa (evidenciaDaAssinatura) e gravada; nunca descartada em
    // silêncio, nunca substituída pela atual. Sem ela ou sem prova, a conclusão é recusada (o registro já vale).
    let assinatura: string | null = m.assinatura;
    let evidencia: EvidenciaAssinatura | null = m.assinatura ? 'REGISTRO' : null;
    if (restituido) {
        if (m.assinatura && input.assinaturaId && input.assinaturaId !== m.assinatura)
            throw erroAcesso('CONFLITO', 'A assinatura informada não é a do registro deste pedido.', 409, { campo: 'assinaturaId' });
        if (!m.assinatura) {
            if (!input.assinaturaId)
                throw erroAcesso('CONFLITO', 'Pedido registrado sem vínculo com o provedor: confira no Asaas e informe a assinatura restituída (sub_…), atual ou anterior, para concluir.', 409, { campo: 'assinaturaId' });
            evidencia = await evidenciaDaAssinatura(tx, input.empresaId, input.assinaturaId, provedor);
            if (!evidencia)
                throw erroAcesso('CONFLITO', 'Não há prova de que esta assinatura é desta empresa (nenhum registro local e nenhuma referência desta empresa no provedor). Confira o id no Asaas ou recupere o vínculo antes de concluir.', 409, { campo: 'assinaturaId' });
            assinatura = input.assinaturaId;
        }
    }
    // Só a assinatura restituída igual à atual encerra o acesso; outra (anterior) não encerra a recontratação.
    const mesma = assinatura !== null && assinatura === m.atual;
    await tx.query(`UPDATE assinatura_arrependimentos SET situacao = $3, concluido_em = clock_timestamp(), concluido_por = $4::uuid, conclusao_referencia = $5,
        valor_restituido_centavos = $6,
        restituicao_limite = CASE WHEN $3 = 'RESTITUIDO' THEN (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date END,
        restituicao_assinatura_id = $7, restituicao_cobranca_ids = $8::text[]
        WHERE empresa_id = $1::uuid AND protocolo = $2`,
        [input.empresaId, input.protocolo, input.situacao, input.usuarioId, input.referencia.trim(), restituido ? input.valorCentavos : null,
            restituido && assinatura !== m.assinatura ? assinatura : null, restituido ? cobrancas : null]);
    // Só encerra o acesso se a empresa ainda estiver na assinatura restituída: concluir um pedido antigo não encerra uma
    // recontratação (outra assinatura). Nesse caso o registro fica RESTITUIDO e encerrou=false.
    let encerrou = false;
    if (restituido && mesma)
        encerrou = (await tx.query(`UPDATE empresa_assinaturas SET situacao = 'ENCERRADA', encerrada_em = clock_timestamp(), periodo_atual_fim = clock_timestamp(),
                cancelada_em = COALESCE(cancelada_em, clock_timestamp()), em_atraso_desde = NULL
            WHERE empresa_id = $1::uuid AND situacao IN ('ATIVA', 'EM_ATRASO', 'CANCELADA_FIM_PERIODO')`, [input.empresaId])).rowCount === 1;
    return { protocolo: input.protocolo, situacao: input.situacao, encerrou, mesmaAssinatura: mesma, evidencia: restituido ? evidencia : null };
}
