/**
 * Sincronização da assinatura com o provedor e processamento dos eventos recebidos (E8), sempre DENTRO da transação
 * de quem chama. Importável sem o driver (só módulos com extensão explícita), para as suítes e a reconciliação.
 *
 *   sincronizarEmpresa  trava a linha da assinatura (FOR UPDATE), RECONSULTA o provedor e aplica estadoDoProvedor.
 *                       A consulta fica dentro da trava de propósito: duas sincronizações da mesma empresa nunca
 *                       aplicam uma leitura antiga depois de uma nova. Cada chamada ao provedor tem 10 s de limite
 *                       (lib/assinatura/asaas.ts), no máximo duas por sincronização. Só a linha desta empresa é travada.
 *   registrarEvento     INSERT ... ON CONFLICT (provedor, evento_id) DO NOTHING — só identificadores.
 *   processarEvento     resolve a empresa pelos ids GRAVADOS no nosso banco e sincroniza; nunca usa o conteúdo do
 *                       evento como estado. Tipo desconhecido ou empresa não encontrada → IGNORADO; provedor fora →
 *                       FALHOU (nova tentativa por reentrega do provedor ou pela reconciliação).
 * Auditoria em `auditoria` (origem COBRANCA): situações e datas, sem valores nem dados pessoais.
 */
import type { DbExecutor } from '../db/contracts';
import type { SituacaoAssinatura } from './acesso.ts';
import type { Ciclo } from './configuracao.ts';
import { AsaasFalhou, type ClienteAsaas } from './asaas.ts';
import { estadoDoProvedor, type EstadoAlvo, type EstadoLocal } from './provedor-estado.ts';
import { auditarCobranca, ORIGEM_COBRANCA, type OrigemSincronizacao } from './sincronizacao-auditoria.ts';
import { ehPendencia, novoRegistroRemocoes, PREFIXO_CRIACAO, PREFIXO_PENDENCIA, PREFIXO_REMOCAO_SEM_CONFIRMACAO, reconciliarContratacao, registrarRemocoes, TIPO_PENDENCIA,
    type ProvedorReconciliacao, type ResultadoReconciliacao, type TransacaoIndependente } from './reconciliacao-contratacao.ts';

export { auditarCobranca, ORIGEM_COBRANCA, type OrigemSincronizacao };

const ISO = (coluna: string) => `to_char((${coluna}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProvedorLeitura = Pick<ClienteAsaas, 'obterAssinatura' | 'listarCobrancasDaAssinatura'>;

type Linha = {
    situacao: SituacaoAssinatura; ciclo: Ciclo | null; periodo_atual_fim: string | null; em_atraso_desde: string | null;
    cancelada_em: string | null; encerrada_em: string | null; provedor: string | null; provedor_cliente_id: string | null;
    provedor_assinatura_id: string | null;
};

export async function assinaturaTravada(tx: DbExecutor, empresaId: string) {
    return (await tx.query<Linha>(
        `SELECT situacao, ciclo, ${ISO('periodo_atual_fim')} AS periodo_atual_fim, ${ISO('em_atraso_desde')} AS em_atraso_desde,
                ${ISO('cancelada_em')} AS cancelada_em, ${ISO('encerrada_em')} AS encerrada_em, provedor, provedor_cliente_id, provedor_assinatura_id
           FROM empresa_assinaturas WHERE empresa_id = $1::uuid FOR UPDATE`, [empresaId])).rows[0] ?? null;
}

export async function agoraDoBanco(tx: DbExecutor) {
    const r = (await tx.query<{ agora: string }>(`SELECT ${ISO('clock_timestamp()')} AS agora`)).rows[0];
    return Date.parse(r.agora);
}

const local = (l: Linha): EstadoLocal => ({
    situacao: l.situacao, ciclo: l.ciclo, periodoAtualFim: l.periodo_atual_fim, emAtrasoDesde: l.em_atraso_desde, canceladaEm: l.cancelada_em, encerradaEm: l.encerrada_em,
});

export type ResultadoSincronizacao =
    | { resultado: 'SEM_ASSINATURA' | 'SEM_PROVEDOR' }
    | { resultado: 'RECUSADA'; motivo: string }
    | { resultado: 'SINCRONIZADA'; antes: SituacaoAssinatura; depois: SituacaoAssinatura; mudou: boolean; recusa: string | null; provedorSituacao: string };

export async function sincronizarEmpresa(tx: DbExecutor, empresaId: string, deps: { provedor: ProvedorLeitura }, origem: OrigemSincronizacao): Promise<ResultadoSincronizacao> {
    const linha = await assinaturaTravada(tx, empresaId);
    if (!linha)
        return { resultado: 'SEM_ASSINATURA' };
    if (!linha.provedor_assinatura_id)
        return { resultado: 'SEM_PROVEDOR' };
    const assinatura = await deps.provedor.obterAssinatura(linha.provedor_assinatura_id);
    // Isolamento: a assinatura consultada tem de ser desta empresa (referência externa) e deste cliente no provedor.
    if (assinatura && ((assinatura.externalReference && assinatura.externalReference !== empresaId)
        || (assinatura.customer && linha.provedor_cliente_id && assinatura.customer !== linha.provedor_cliente_id))) {
        await auditarCobranca(tx, { acao: 'ASSINATURA_SINCRONIZACAO_RECUSADA', empresaId, origem, depois: { motivo: 'REFERENCIA_DIVERGENTE' } });
        return { resultado: 'RECUSADA', motivo: 'REFERENCIA_DIVERGENTE' };
    }
    const pagamentos = assinatura ? await deps.provedor.listarCobrancasDaAssinatura(assinatura.id) : [];
    const agora = await agoraDoBanco(tx);
    const alvo: EstadoAlvo = estadoDoProvedor(local(linha), assinatura, pagamentos, agora);
    if (alvo.mudou) {
        await tx.query(
            `UPDATE empresa_assinaturas SET situacao = $2, ciclo = $3, periodo_atual_fim = $4::timestamptz, em_atraso_desde = $5::timestamptz,
                    cancelada_em = $6::timestamptz, encerrada_em = $7::timestamptz, provedor_situacao = $8, sincronizado_em = clock_timestamp()
              WHERE empresa_id = $1::uuid`,
            [empresaId, alvo.situacao, alvo.ciclo, alvo.periodoAtualFim, alvo.emAtrasoDesde, alvo.canceladaEm, alvo.encerradaEm, alvo.provedorSituacao]);
        await auditarCobranca(tx, {
            acao: 'ASSINATURA_SINCRONIZADA', empresaId, origem,
            antes: { situacao: linha.situacao, periodoAtualFim: linha.periodo_atual_fim, emAtrasoDesde: linha.em_atraso_desde },
            depois: { situacao: alvo.situacao, periodoAtualFim: alvo.periodoAtualFim, emAtrasoDesde: alvo.emAtrasoDesde, provedorSituacao: alvo.provedorSituacao },
        });
    }
    else {
        await tx.query('UPDATE empresa_assinaturas SET provedor_situacao = $2, sincronizado_em = clock_timestamp() WHERE empresa_id = $1::uuid', [empresaId, alvo.provedorSituacao]);
        if (alvo.recusa)
            await auditarCobranca(tx, { acao: 'ASSINATURA_SINCRONIZACAO_SEM_TRANSICAO', empresaId, origem, depois: { situacao: linha.situacao, motivo: alvo.recusa, provedorSituacao: alvo.provedorSituacao } });
    }
    return { resultado: 'SINCRONIZADA', antes: linha.situacao, depois: alvo.situacao, mudou: alvo.mudou, recusa: alvo.recusa, provedorSituacao: alvo.provedorSituacao };
}

// ---------------------------------------------------------------------------------------------------------------------
// Eventos do provedor

/** Tipos que disparam reconsulta. Qualquer outro é registrado e marcado IGNORADO. https://docs.asaas.com/docs/sobre-os-webhooks */
export const EVENTOS_SUPORTADOS = new Set([
    'PAYMENT_CREATED', 'PAYMENT_UPDATED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_OVERDUE', 'PAYMENT_DELETED', 'PAYMENT_RESTORED',
    'PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_RECEIVED_IN_CASH_UNDONE', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE',
    'PAYMENT_AWAITING_CHARGEBACK_REVERSAL', 'SUBSCRIPTION_CREATED', 'SUBSCRIPTION_UPDATED', 'SUBSCRIPTION_INACTIVATED', 'SUBSCRIPTION_DELETED',
]);

export type EventoRecebido = {
    eventoId: string; tipo: string; criadoNoProvedor: string | null; assinaturaId: string | null; cobrancaId: string | null; checkoutId: string | null; referenciaExterna: string | null;
};

const ID_EVENTO = /^[A-Za-z0-9_.:-]{1,200}$/;
const ID_PROVEDOR = /^[A-Za-z0-9_-]{1,100}$/;
const TIPO = /^[A-Z0-9_]{1,80}$/;
const opcional = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : null);
const objeto = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

/** Extrai SÓ identificadores do corpo do webhook (nada de nome, documento, e-mail ou valor). null = corpo inválido. */
export function extrairEvento(corpo: unknown): EventoRecebido | null {
    const o = objeto(corpo);
    if (!o || typeof o.id !== 'string' || !ID_EVENTO.test(o.id) || typeof o.event !== 'string' || !TIPO.test(o.event))
        return null;
    // Pendências internas de reconciliação nunca vêm de fora: o webhook não aceita o tipo nem o prefixo reservados.
    if (o.event === TIPO_PENDENCIA || o.event.startsWith('KIDMAIS_') || o.id.toLowerCase().startsWith(PREFIXO_PENDENCIA))
        return null;
    const pagamento = objeto(o.payment), assinatura = objeto(o.subscription), checkout = objeto(o.checkout);
    const referencia = opcional(pagamento?.externalReference, /^.{1,200}$/s) ?? opcional(assinatura?.externalReference, /^.{1,200}$/s);
    return {
        eventoId: o.id, tipo: o.event,
        criadoNoProvedor: typeof o.dateCreated === 'string' ? o.dateCreated.slice(0, 40) : null,
        assinaturaId: opcional(pagamento?.subscription, ID_PROVEDOR) ?? opcional(assinatura?.id, ID_PROVEDOR),
        cobrancaId: opcional(pagamento?.id, ID_PROVEDOR),
        checkoutId: opcional(checkout?.id, ID_PROVEDOR),
        referenciaExterna: referencia && UUID.test(referencia) ? referencia.toLowerCase() : null,
    };
}

/** Grava o evento uma única vez. Devolve o id interno e se ainda precisa ser processado. */
export async function registrarEvento(tx: DbExecutor, e: EventoRecebido) {
    const novo = (await tx.query<{ id: string }>(
        `INSERT INTO cobranca_eventos (provedor, evento_id, tipo, criado_no_provedor, assinatura_provedor_id, cobranca_provedor_id, checkout_provedor_id, referencia_externa)
         VALUES ('ASAAS', $1, $2, $3, $4, $5, $6, $7) ON CONFLICT (provedor, evento_id) DO NOTHING RETURNING id`,
        [e.eventoId, e.tipo, e.criadoNoProvedor, e.assinaturaId, e.cobrancaId, e.checkoutId, e.referenciaExterna])).rows[0];
    if (novo)
        return { id: novo.id, duplicado: false, pendente: true };
    const existente = (await tx.query<{ id: string; situacao: string }>(
        "SELECT id, situacao FROM cobranca_eventos WHERE provedor = 'ASAAS' AND evento_id = $1", [e.eventoId])).rows[0];
    return { id: existente.id, duplicado: true, pendente: existente.situacao === 'PENDENTE' || existente.situacao === 'FALHOU' };
}

type LinhaEvento = { id: string; tipo: string; situacao: string; assinatura_provedor_id: string | null; referencia_externa: string | null; empresa_id: string | null; evento_id: string };

async function resolverEmpresa(tx: DbExecutor, ev: LinhaEvento) {
    if (ev.empresa_id)
        return ev.empresa_id;
    if (ev.assinatura_provedor_id) {
        const r = (await tx.query<{ empresa_id: string }>(
            "SELECT empresa_id FROM empresa_assinaturas WHERE provedor = 'ASAAS' AND provedor_assinatura_id = $1", [ev.assinatura_provedor_id])).rows[0];
        if (r)
            return r.empresa_id;
    }
    // Referência externa = id da empresa (gravado por nós na criação). Só serve para escolher QUEM reconsultar: a
    // sincronização usa os ids gravados no nosso banco, nunca o conteúdo do evento.
    if (ev.referencia_externa) {
        const r = (await tx.query<{ empresa_id: string }>(
            "SELECT empresa_id FROM empresa_assinaturas WHERE empresa_id = $1::uuid AND provedor = 'ASAAS' AND provedor_assinatura_id IS NOT NULL", [ev.referencia_externa])).rows[0];
        if (r)
            return r.empresa_id;
    }
    return null;
}

const codigoErro = (error: unknown) => error instanceof AsaasFalhou
    ? `PROVEDOR_INDISPONIVEL: ${error.operacao}${error.status ? ` (${error.status})` : ''}`.slice(0, 500)
    : `ERRO_INTERNO: ${error instanceof Error ? error.name : typeof error}`.slice(0, 500);

export type ResultadoEvento = { situacao: 'PROCESSADO' | 'IGNORADO' | 'FALHOU' | 'JA_CONCLUIDO'; empresaId: string | null; motivo?: string };

/**
 * Processa um evento gravado (transação do chamador). A sincronização roda num SAVEPOINT: se o provedor falhar,
 * a transação continua válida e o evento fica FALHOU com a tentativa contada.
 */
/** `transacaoIndependente`: outra conexão com COMMIT próprio, para o marcador de exclusão (sem ela, nada é excluído). */
export async function processarEvento(tx: DbExecutor, eventoInternoId: string, deps: { provedor: ProvedorLeitura & Partial<ProvedorReconciliacao>; transacaoIndependente?: TransacaoIndependente }): Promise<ResultadoEvento> {
    const ev = (await tx.query<LinhaEvento>(
        `SELECT id, evento_id, tipo, situacao, assinatura_provedor_id, referencia_externa, empresa_id FROM cobranca_eventos WHERE id = $1::uuid FOR UPDATE`, [eventoInternoId])).rows[0];
    if (!ev || ev.situacao === 'PROCESSADO' || ev.situacao === 'IGNORADO')
        return { situacao: 'JA_CONCLUIDO', empresaId: ev?.empresa_id ?? null };
    const concluir = async (situacao: 'PROCESSADO' | 'IGNORADO', empresaId: string | null, motivo: string | null) => {
        await tx.query(
            `UPDATE cobranca_eventos SET situacao = $2, empresa_id = COALESCE(empresa_id, $3::uuid), tentativas = tentativas + 1, ultimo_erro = $4, processado_em = clock_timestamp()
              WHERE id = $1::uuid`, [ev.id, situacao, empresaId, motivo]);
        return { situacao, empresaId, ...(motivo ? { motivo } : {}) };
    };
    if (ehPendencia(ev))
        return processarPendencia(tx, ev, deps.provedor, concluir, deps.transacaoIndependente);
    if (!EVENTOS_SUPORTADOS.has(ev.tipo))
        return concluir('IGNORADO', null, 'TIPO_NAO_TRATADO');
    const empresaId = await resolverEmpresa(tx, ev);
    if (!empresaId)
        return concluir('IGNORADO', null, 'EMPRESA_NAO_ENCONTRADA');
    await tx.query('SAVEPOINT kidmais_evento_cobranca');
    try {
        const r = await sincronizarEmpresa(tx, empresaId, deps, { tipo: 'WEBHOOK', eventoId: ev.evento_id });
        await tx.query('RELEASE SAVEPOINT kidmais_evento_cobranca');
        if (r.resultado === 'RECUSADA')
            return concluir('IGNORADO', empresaId, r.motivo);
        return concluir('PROCESSADO', empresaId, null);
    }
    catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT kidmais_evento_cobranca');
        const motivo = codigoErro(error);
        await tx.query(
            `UPDATE cobranca_eventos SET situacao = 'FALHOU', empresa_id = COALESCE(empresa_id, $2::uuid), tentativas = tentativas + 1, ultimo_erro = $3 WHERE id = $1::uuid`,
            [ev.id, empresaId, motivo]);
        return { situacao: 'FALHOU', empresaId, motivo };
    }
}

/**
 * Pendência de reconciliação da contratação (lib/assinatura/reconciliacao-contratacao.ts). Resolvida → PROCESSADO (e a
 * empresa é sincronizada se ficou vinculada). Precisa de pessoa (várias assinaturas sem vínculo, duplicata paga) ou
 * provedor fora → FALHOU com o motivo, visível e reprocessável. Nunca IGNORADO: não some em silêncio.
 */
async function processarPendencia(tx: DbExecutor, ev: LinhaEvento, provedor: ProvedorLeitura & Partial<ProvedorReconciliacao>,
    concluir: (situacao: 'PROCESSADO' | 'IGNORADO', empresaId: string | null, motivo: string | null) => Promise<ResultadoEvento>,
    independente?: TransacaoIndependente): Promise<ResultadoEvento> {
    const empresaId = ev.empresa_id!;
    const falhar = async (motivo: string) => {
        await tx.query(`UPDATE cobranca_eventos SET situacao = 'FALHOU', tentativas = tentativas + 1, ultimo_erro = $2 WHERE id = $1::uuid`, [ev.id, motivo.slice(0, 500)]);
        return { situacao: 'FALHOU' as const, empresaId, motivo };
    };
    if (!provedor.listarAssinaturasPorReferencia || !provedor.removerAssinatura)
        return falhar('PROVEDOR_SEM_ESCRITA');
    const registro = novoRegistroRemocoes();
    const origem = { tipo: 'RECONCILIACAO' as const, eventoId: ev.evento_id };
    let r: ResultadoReconciliacao | null = null;
    let erro: unknown = null;
    await tx.query('SAVEPOINT kidmais_pendencia_contratacao');
    try {
        r = await reconciliarContratacao(tx, empresaId, provedor as ProvedorReconciliacao, null,
            { criacao: ev.evento_id.startsWith(PREFIXO_CRIACAO), assinaturaId: ev.assinatura_provedor_id }, registro, independente);
        if (r.resultado === 'VINCULADA' || r.resultado === 'CONCILIADA')
            await sincronizarEmpresa(tx, empresaId, { provedor }, { tipo: 'RECONCILIACAO', eventoId: ev.evento_id });
        await tx.query('RELEASE SAVEPOINT kidmais_pendencia_contratacao');
    }
    catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT kidmais_pendencia_contratacao');
        erro = error;
    }
    // Marcador de exclusão sem confirmação: só fecha quando a releitura confirma a exclusão.
    const marcador = ev.evento_id.startsWith(PREFIXO_REMOCAO_SEM_CONFIRMACAO);
    const marcadorConfirmado = registro.confirmadasNaReleitura.some((m) => m.marcadorId === ev.id);
    const concluido = !erro && r !== null && r.resultado !== 'REVISAO_HUMANA' && r.resultado !== 'AGUARDANDO' && r.resultado !== 'ADIADA' && (!marcador || marcadorConfirmado);
    // Exclusões feitas no provedor ficam registradas mesmo quando a operação seguinte falhou (o SAVEPOINT desfeito não as leva).
    await registrarRemocoes(tx, empresaId, registro, origem, { id: ev.id, concluido });
    if (erro || !r)
        return falhar(codigoErro(erro));
    if (r.resultado === 'REVISAO_HUMANA')
        return falhar(`REVISAO_HUMANA: ${r.motivo}`);
    if (r.resultado === 'AGUARDANDO')
        return falhar(`AGUARDANDO_CONFIRMACAO: ${r.motivo}`);
    // Marcador não confirmado no banco: nada foi excluído; nova tentativa no reprocessamento.
    if (r.resultado === 'ADIADA')
        return falhar(`ADIADA: ${r.motivo}`);
    if (marcador && !marcadorConfirmado)
        return falhar('REVISAO_HUMANA: REMOCAO_SEM_CONFIRMACAO');
    return concluir('PROCESSADO', empresaId, marcador ? 'REMOCAO_CONFIRMADA_NA_RELEITURA' : r.resultado);
}

/** Eventos a reprocessar (PENDENTE/FALHOU), mais antigos primeiro. */
export async function eventosPendentes(tx: DbExecutor, limite = 200) {
    return (await tx.query<{ id: string }>(
        "SELECT id FROM cobranca_eventos WHERE provedor = 'ASAAS' AND situacao IN ('PENDENTE', 'FALHOU') ORDER BY recebido_em LIMIT $1", [limite])).rows.map((r) => r.id);
}

/** Empresas com assinatura vinculada ao provedor (alvo da reconciliação). */
export async function empresasComProvedor(tx: DbExecutor) {
    return (await tx.query<{ empresa_id: string }>(
        "SELECT empresa_id FROM empresa_assinaturas WHERE provedor = 'ASAAS' AND provedor_assinatura_id IS NOT NULL ORDER BY empresa_id")).rows.map((r) => r.empresa_id);
}
