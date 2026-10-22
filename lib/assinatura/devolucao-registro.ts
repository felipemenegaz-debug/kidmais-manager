/**
 * Registro dos pedidos de cancelamento e devolução (089) e e-mail de confirmação com o protocolo. Sem a 089 instalada,
 * nada é gravado aqui (o cancelamento ao fim do período segue como antes, sem protocolo).
 * Nenhuma função registra id do provedor, valor ou dado pessoal em log.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import type { EnviarEmail, MensagemEmail } from '../acessos/email.ts';
import { gerarProtocolo, PROTOCOLO, type TipoPedido } from './devolucao-calculo.ts';
import { canaisSuporte } from '../suporte/canais.ts';

export async function encerramentosInstalados(tx: DbExecutor) {
    return (await tx.query<{ ok: boolean }>("SELECT to_regclass('public.assinatura_encerramentos') IS NOT NULL AS ok")).rows[0]?.ok === true;
}

/** Cobranças com pedido de devolução (089): nunca sustentam período pago na sincronização. Sem a 089: nenhuma. */
export type CobrancasDevolvidas = { ids: Set<string>; limites: Map<string, string> };
/**
 * Cobranças com pedido de devolução (089) e, por assinatura do provedor, o vencimento da cobrança devolvida mais recente
 * (`inicio_ciclo`). P2-1 da revisão de 21/10/2026: na assinatura que teve devolução, nenhuma cobrança com vencimento
 * MENOR OU IGUAL a esse limite sustenta período (a renovação do 2º ano devolvida não deixa a do 1º ano reabrir a empresa);
 * só um pagamento com vencimento posterior, ou de outra assinatura (recontratação), reativa. Sem a 089: nada.
 */
export async function cobrancasDevolvidas(tx: DbExecutor, empresaId: string): Promise<CobrancasDevolvidas> {
    if (!await encerramentosInstalados(tx)) return { ids: new Set(), limites: new Map() };
    const linhas = (await tx.query<{ id: string; assinatura: string; inicio: string }>(
        `SELECT cobranca_provedor_id AS id, provedor_assinatura_id AS assinatura, to_char(inicio_ciclo, 'YYYY-MM-DD') AS inicio
           FROM assinatura_encerramentos WHERE empresa_id = $1::uuid AND cobranca_provedor_id IS NOT NULL`, [empresaId])).rows;
    const limites = new Map<string, string>();
    for (const l of linhas)
        if (!limites.has(l.assinatura) || limites.get(l.assinatura)! < l.inicio) limites.set(l.assinatura, l.inicio);
    return { ids: new Set(linhas.map((l) => l.id)), limites };
}
/** Cobrança que não sustenta período na sincronização (ver cobrancasDevolvidas). */
export const cobrancaDevolvidaOuAnterior = (d: CobrancasDevolvidas, assinaturaId: string, c: { id: string; dueDate: string }) => {
    const limite = d.limites.get(assinaturaId);
    return d.ids.has(c.id) || (limite !== undefined && c.dueDate <= limite);
};

/**
 * P3-8: a releitura comprovou que a assinatura não existe mais (`deleted=true` lida por id): os pedidos desta empresa
 * para ela que ainda esperavam a remoção (PENDENTE/SEM_CONFIRMACAO/RECUSADO) passam a AUSENTE (ausência comprovada, sem
 * atribuir autoria). Sem a 089: nada.
 */
export async function registrarAusenciaNoProvedor(tx: DbExecutor, empresaId: string, assinaturaId: string) {
    if (!await encerramentosInstalados(tx)) return 0;
    return (await tx.query(`UPDATE assinatura_encerramentos SET cancelamento_provedor = 'AUSENTE'
        WHERE empresa_id = $1::uuid AND provedor_assinatura_id = $2 AND cancelamento_provedor IN ('PENDENTE', 'SEM_CONFIRMACAO', 'RECUSADO')`,
    [empresaId, assinaturaId])).rowCount ?? 0;
}

export type CancelamentoProvedor = 'PENDENTE' | 'CONFIRMADO' | 'AUSENTE' | 'JA_REMOVIDA' | 'SEM_CONFIRMACAO' | 'RECUSADO';
export type SituacaoEstorno = 'NAO_SE_APLICA' | 'AGUARDANDO_MANUAL' | 'EM_CURSO' | 'SOLICITADO' | 'SEM_CONFIRMACAO' | 'RECUSADO' | 'CONCLUIDO';
export type SituacaoEmail = 'PENDENTE' | 'ENVIADO' | 'FALHOU' | 'NAO_CONFIGURADO';

export type NovoPedido = {
    empresaId: string; tipo: TipoPedido; chave: string; solicitadoPor: string; motivo: string | null; ciclo: 'MENSAL' | 'ANUAL' | null;
    situacaoAnterior: string; provedorAssinaturaId: string; cancelamentoProvedor: CancelamentoProvedor;
    devolucao?: {
        regra: string; cobrancaId: string; formaPagamento: string | null; valorPagoCentavos: number; inicioCiclo: string; dataAtivacao: string;
        diasCiclo: number | null; diasUtilizados: number | null; valorDevolucaoCentavos: number; prazoProcessamento: string;
        periodoFimAnterior: string | null; acessoPagoEncerradoEm: string;
    };
};

export type PedidoResumo = {
    id: string; protocolo: string; tipo: TipoPedido; solicitadoEm: string; valorDevolucaoCentavos: number | null; prazoProcessamento: string | null;
    acessoPagoEncerradoEm: string | null; cancelamentoProvedor: CancelamentoProvedor; estorno: SituacaoEstorno; email: SituacaoEmail;
};

const ISO = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const COLUNAS_RESUMO = `id, protocolo, tipo, ${ISO('solicitado_em')} AS "solicitadoEm", valor_devolucao_centavos AS "valorDevolucaoCentavos",
    to_char(prazo_processamento, 'YYYY-MM-DD') AS "prazoProcessamento", ${ISO('acesso_pago_encerrado_em')} AS "acessoPagoEncerradoEm",
    cancelamento_provedor AS "cancelamentoProvedor", estorno_situacao AS estorno, email_situacao AS email`;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Chave enviada pela tela (uuid); ausente ou inválida → nova (sem idempotência entre cliques, mas nunca rejeitada). */
export const chaveDoPedido = (v: unknown) => (typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : randomUUID());

/** Pedido já registrado com a mesma chave (repetição do mesmo clique ou da mesma requisição). */
export async function pedidoPorChave(tx: DbExecutor, empresaId: string, chave: string) {
    return (await tx.query<PedidoResumo>(`SELECT ${COLUNAS_RESUMO} FROM assinatura_encerramentos WHERE empresa_id = $1::uuid AND chave_idempotencia = $2::uuid`,
        [empresaId, chave])).rows[0] ?? null;
}

export async function pedidosDaEmpresa(tx: DbExecutor, empresaId: string, limite = 10) {
    return (await tx.query<PedidoResumo>(`SELECT ${COLUNAS_RESUMO} FROM assinatura_encerramentos WHERE empresa_id = $1::uuid ORDER BY solicitado_em DESC LIMIT $2`,
        [empresaId, limite])).rows;
}

/** Insere o pedido com um protocolo novo (colisão do protocolo — improvável — repete uma vez com outro sufixo). */
export async function registrarPedido(tx: DbExecutor, p: NovoPedido): Promise<PedidoResumo> {
    const d = p.devolucao;
    for (let tentativa = 0; ; tentativa += 1) {
        const protocolo = gerarProtocolo(Date.now(), randomBytes(8));
        if (!PROTOCOLO.test(protocolo)) throw new Error('Protocolo inválido.');
        await tx.query('SAVEPOINT kidmais_089_protocolo');
        try {
            const r = (await tx.query<PedidoResumo>(
                `INSERT INTO assinatura_encerramentos (protocolo, empresa_id, tipo, chave_idempotencia, solicitado_por, motivo, ciclo, situacao_anterior,
                    provedor_assinatura_id, cancelamento_provedor, estorno_situacao, regra, cobranca_provedor_id, forma_pagamento, valor_pago_centavos,
                    inicio_ciclo, data_ativacao, dias_ciclo, dias_utilizados, valor_devolucao_centavos, prazo_processamento, periodo_fim_anterior, acesso_pago_encerrado_em)
                 VALUES ($1, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::date, $17::date, $18, $19, $20, $21::date,
                    $22::timestamptz, $23::timestamptz)
                 RETURNING ${COLUNAS_RESUMO}`,
                [protocolo, p.empresaId, p.tipo, p.chave, p.solicitadoPor, p.motivo || null, p.ciclo, p.situacaoAnterior, p.provedorAssinaturaId,
                    p.cancelamentoProvedor, d ? 'AGUARDANDO_MANUAL' : 'NAO_SE_APLICA', d?.regra ?? null, d?.cobrancaId ?? null, d?.formaPagamento ?? null,
                    d?.valorPagoCentavos ?? null, d?.inicioCiclo ?? null, d?.dataAtivacao ?? null, d?.diasCiclo ?? null, d?.diasUtilizados ?? null,
                    d?.valorDevolucaoCentavos ?? null, d?.prazoProcessamento ?? null, d?.periodoFimAnterior ?? null, d?.acessoPagoEncerradoEm ?? null])).rows[0];
            await tx.query('RELEASE SAVEPOINT kidmais_089_protocolo');
            return r;
        }
        catch (error) {
            await tx.query('ROLLBACK TO SAVEPOINT kidmais_089_protocolo');
            const colisao = (error as { code?: string; constraint?: string }).code === '23505' && (error as { constraint?: string }).constraint === 'assinatura_encerramentos_protocolo_key';
            if (!colisao || tentativa >= 1) throw error;
        }
    }
}

export async function atualizarCancelamentoProvedor(tx: DbExecutor, empresaId: string, id: string, resultado: CancelamentoProvedor) {
    await tx.query(`UPDATE assinatura_encerramentos SET cancelamento_provedor = $3 WHERE id = $1::uuid AND empresa_id = $2::uuid
        AND cancelamento_provedor IN ('PENDENTE', 'SEM_CONFIRMACAO', 'RECUSADO') AND cancelamento_provedor <> $3`, [id, empresaId, resultado]);
}

/** Registro prévio da chamada automática: só a partir de AGUARDANDO_MANUAL; false = outro processo já tentou. */
export async function marcarEstornoEmCurso(tx: DbExecutor, empresaId: string, id: string) {
    return ((await tx.query(`UPDATE assinatura_encerramentos SET estorno_situacao = 'EM_CURSO', estorno_modo = 'AUTOMATICO'
        WHERE id = $1::uuid AND empresa_id = $2::uuid AND estorno_situacao = 'AGUARDANDO_MANUAL'`, [id, empresaId])).rowCount ?? 0) === 1;
}

export async function registrarResultadoEstorno(tx: DbExecutor, empresaId: string, id: string, situacao: 'SOLICITADO' | 'SEM_CONFIRMACAO' | 'RECUSADO', statusProvedor: string | null) {
    await tx.query(`UPDATE assinatura_encerramentos SET estorno_situacao = $3, estorno_status_provedor = $4
        WHERE id = $1::uuid AND empresa_id = $2::uuid AND estorno_situacao = 'EM_CURSO'`,
    [id, empresaId, situacao, statusProvedor && /^[A-Z_]{1,40}$/.test(statusProvedor) ? statusProvedor : null]);
}

export async function registrarEmail(tx: DbExecutor, empresaId: string, id: string, situacao: Exclude<SituacaoEmail, 'PENDENTE'>) {
    await tx.query(`UPDATE assinatura_encerramentos SET email_situacao = $3 WHERE id = $1::uuid AND empresa_id = $2::uuid
        AND email_situacao IN ('PENDENTE', 'FALHOU', 'NAO_CONFIGURADO') AND email_situacao <> $3`, [id, empresaId, situacao]);
}

// ---------------------------------------------------------------------------------------------------------------------
// E-mail de confirmação (transporte do app, lib/acessos/email.ts; nos testes, provedor `arquivo` ou dublê)

const reais = (centavos: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(centavos / 100);
const dataBr = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');
const horaBr = (iso: string) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(iso));
function escapar(texto: string) {
    return texto.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export const TITULO_PEDIDO: Record<TipoPedido, string> = {
    CANCELAMENTO_FIM_PERIODO: 'Cancelamento da renovação',
    ARREPENDIMENTO_7_DIAS: 'Arrependimento em 7 dias (devolução integral)',
    ENCERRAMENTO_ANUAL_PROPORCIONAL: 'Encerramento antecipado do plano anual (devolução proporcional)',
};

export function mensagemConfirmacao(input: { para: string; empresa: string; pedido: PedidoResumo; periodoFim: string | null; estornoAutomatico: boolean }): MensagemEmail {
    const p = input.pedido;
    const linhas = [
        `Recebemos o pedido de ${TITULO_PEDIDO[p.tipo].toLowerCase()} de ${input.empresa} no Kidmais Manager.`,
        `Protocolo: ${p.protocolo}. Registrado em ${horaBr(p.solicitadoEm)} (horário de Brasília).`,
    ];
    if (p.tipo === 'CANCELAMENTO_FIM_PERIODO')
        linhas.push(`A assinatura não será renovada. O acesso completo continua até ${input.periodoFim ? dataBr(input.periodoFim) : 'o fim do período pago'}; depois, a empresa fica em somente leitura por 60 dias, com exportação dos dados. Nada é apagado agora.`);
    else {
        linhas.push(`O acesso pago foi encerrado em ${p.acessoPagoEncerradoEm ? horaBr(p.acessoPagoEncerradoEm) : 'na data do pedido'}. A empresa fica em somente leitura por 60 dias, com exportação dos dados. Nada é apagado agora.`);
        linhas.push(`Valor a devolver: ${reais(p.valorDevolucaoCentavos ?? 0)}.`
            + (p.tipo === 'ARREPENDIMENTO_7_DIAS'
                ? ' Por ser arrependimento, a restituição é iniciada de imediato, sem desconto de taxas; o crédito depende do meio de pagamento usado.'
                : ` O processamento começa até ${p.prazoProcessamento ? dataBr(p.prazoProcessamento) : 'o 5º dia útil'} (5 dias úteis); o crédito depende do meio de pagamento e será acompanhado por nós.`));
        if (!input.estornoAutomatico)
            linhas.push('A devolução é feita pela nossa equipe no provedor de pagamento. Se o pagamento foi por boleto, poderemos pedir os dados bancários para a devolução.');
    }
    linhas.push('Dúvidas: contato@demerzellabs.com.br, informando o protocolo.');
    const texto = linhas.join('\n\n');
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">${linhas.map((l) => `<p>${escapar(l)}</p>`).join('')}</div>`;
    return { para: input.para, assunto: `Kidmais Manager — protocolo ${p.protocolo}`, texto, html, idempotencia: `encerramento:${p.id}` };
}

/** Envia (melhor esforço) e grava a situação. Falha no envio nunca desfaz o pedido. */
export async function enviarConfirmacao(deps: { enviarEmail?: EnviarEmail | null; withTransaction: <T>(t: (tx: DbExecutor) => Promise<T>) => Promise<T> },
    empresaId: string, mensagem: MensagemEmail, pedidoId: string): Promise<SituacaoEmail> {
    if (!deps.enviarEmail) return 'PENDENTE';
    let situacao: Exclude<SituacaoEmail, 'PENDENTE'>;
    try {
        await deps.enviarEmail(mensagem);
        situacao = 'ENVIADO';
    }
    catch (error) {
        situacao = (error as { code?: string }).code === 'EMAIL_NAO_CONFIGURADO' ? 'NAO_CONFIGURADO' : 'FALHOU';
        console.warn('[assinatura] e-mail de confirmação do pedido não enviado', situacao);
    }
    try {
        await deps.withTransaction((tx) => registrarEmail(tx, empresaId, pedidoId, situacao));
    }
    catch (error) {
        console.error('[assinatura] situação do e-mail não gravada', error instanceof Error ? error.name : typeof error);
    }
    return situacao;
}

// ---------------------------------------------------------------------------------------------------------------------
// Aviso interno imediato à plataforma (P2-3): canal SITE_ATENDIMENTO_EMAIL, transporte do app, melhor esforço.

/** Canal da plataforma para o aviso interno (o mesmo endereço validado da tela de suporte); null = não configurado. */
export const canalDaPlataforma = (env: Record<string, string | undefined> = process.env) => canaisSuporte(env).email;

export type DetalhesAviso = { formaPagamento: string | null; prazoArrependimento: boolean };
/**
 * Só o necessário para agir: protocolo, tipo, valor, prazo, meio de pagamento e situação no provedor. Sem nome da
 * empresa, pessoa, e-mail, documento ou ids do provedor: o protocolo localiza o pedido na fila (doc §5).
 */
export function mensagemAvisoInterno(input: { para: string; pedido: PedidoResumo; detalhes: DetalhesAviso }): MensagemEmail {
    const p = input.pedido;
    const prazo = p.tipo === 'ARREPENDIMENTO_7_DIAS' ? 'IMEDIATO (arrependimento: restituir hoje, sem taxas, e comunicar o intermediador)'
        : p.prazoProcessamento ? `iniciar até ${dataBr(p.prazoProcessamento)} (5 dias úteis)` : 'sem devolução';
    const linhas = [
        `Novo pedido na tela Assinatura: ${TITULO_PEDIDO[p.tipo]}.`,
        `Protocolo: ${p.protocolo}. Registrado em ${horaBr(p.solicitadoEm)} (Brasília).`,
        p.valorDevolucaoCentavos ? `Valor a devolver: ${reais(p.valorDevolucaoCentavos)}. Meio de pagamento: ${input.detalhes.formaPagamento ?? 'não informado'}.` : 'Sem devolução (cancelamento da renovação).',
        `Prazo: ${prazo}.`,
        `Renovação no provedor: ${p.cancelamentoProvedor}. Estorno: ${p.estorno}.`,
        'Processar pela fila de pedidos (docs/CANCELAMENTO_DEVOLUCAO_20261021.md, seção 5), localizando pelo protocolo.',
    ];
    const texto = linhas.join('\n\n');
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">${linhas.map((l) => `<p>${escapar(l)}</p>`).join('')}</div>`;
    const urgente = p.tipo === 'ARREPENDIMENTO_7_DIAS' || (p.cancelamentoProvedor !== 'CONFIRMADO' && p.cancelamentoProvedor !== 'AUSENTE' && p.cancelamentoProvedor !== 'JA_REMOVIDA');
    return { para: input.para, assunto: `${urgente ? '[AÇÃO HOJE] ' : ''}Kidmais Manager — pedido ${p.protocolo} (${TITULO_PEDIDO[p.tipo]})`, texto, html,
        idempotencia: `encerramento-interno:${p.id}` };
}

export async function registrarAvisoInterno(tx: DbExecutor, empresaId: string, id: string, situacao: Exclude<SituacaoEmail, 'PENDENTE'>) {
    await tx.query(`UPDATE assinatura_encerramentos SET aviso_interno_situacao = $3 WHERE id = $1::uuid AND empresa_id = $2::uuid
        AND aviso_interno_situacao IN ('PENDENTE', 'FALHOU', 'NAO_CONFIGURADO') AND aviso_interno_situacao <> $3`, [id, empresaId, situacao]);
}

/** Aviso interno (melhor esforço; nunca desfaz o pedido). Canal ausente → NAO_CONFIGURADO gravado (a D-C4 continua cobrindo). */
export async function enviarAvisoInterno(deps: { enviarEmail?: EnviarEmail | null; withTransaction: <T>(t: (tx: DbExecutor) => Promise<T>) => Promise<T>; env?: Record<string, string | undefined> },
    empresaId: string, pedido: PedidoResumo, detalhes: DetalhesAviso): Promise<SituacaoEmail> {
    if (!deps.enviarEmail) return 'PENDENTE';
    const para = canalDaPlataforma(deps.env ?? process.env);
    let situacao: Exclude<SituacaoEmail, 'PENDENTE'>;
    if (!para) situacao = 'NAO_CONFIGURADO';
    else {
        try {
            await deps.enviarEmail(mensagemAvisoInterno({ para, pedido, detalhes }));
            situacao = 'ENVIADO';
        }
        catch (error) {
            situacao = (error as { code?: string }).code === 'EMAIL_NAO_CONFIGURADO' ? 'NAO_CONFIGURADO' : 'FALHOU';
        }
    }
    if (situacao !== 'ENVIADO') console.warn('[assinatura] aviso interno do pedido não enviado', situacao);
    try {
        await deps.withTransaction((tx) => registrarAvisoInterno(tx, empresaId, pedido.id, situacao));
    }
    catch (error) {
        console.error('[assinatura] situação do aviso interno não gravada', error instanceof Error ? error.name : typeof error);
    }
    return situacao;
}

/** Destinatário: a própria pessoa da Gestão que fez o pedido (e-mail da conta). */
export async function emailDoSolicitante(tx: DbExecutor, usuarioId: string) {
    return (await tx.query<{ email: string | null }>('SELECT email FROM usuarios_administrativos WHERE id = $1::uuid', [usuarioId])).rows[0]?.email ?? null;
}
