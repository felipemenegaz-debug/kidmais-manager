/**
 * Regras puras dos créditos de IA (090): alocação de lotes, decisão sobre o pagamento lido no provedor, cálculo da
 * devolução de pacote e datas em São Paulo. Sem banco, sem rede; aritmética inteira (BigInt onde o produto pode passar
 * de 2^53). Testes: lib/creditos/dominio.test.ts.
 */
import { dataBrasilia, gerarProtocolo, PROTOCOLO, somarDias, somarDiasUteis } from '../assinatura/devolucao-calculo.ts';
import type { Recurso } from './catalogo.ts';

export { gerarProtocolo, PROTOCOLO, dataBrasilia };
export type Origem = 'FRANQUIA' | 'COMPRA' | 'CORTESIA' | 'LEGADO';
export type Forma = 'PIX' | 'CARTAO' | 'BOLETO';
export const FORMAS: readonly Forma[] = ['PIX', 'CARTAO', 'BOLETO'];
/** billingType do Asaas para cada forma (cobrança avulsa; cartão só na página hospedada do provedor). */
export const BILLING_TYPE: Record<Forma, 'PIX' | 'CREDIT_CARD' | 'BOLETO'> = { PIX: 'PIX', CARTAO: 'CREDIT_CARD', BOLETO: 'BOLETO' };
export const REGRA_DEVOLUCAO_PACOTE = 'PACOTE-20261022-PROPOSTA';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ehUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** externalReference do pedido: correlação (não é chave de idempotência do provedor). Sem nome, CPF ou e-mail. */
export function referenciaExterna(ambiente: 'sandbox' | 'producao', pedidoId: string) {
    if (!ehUuid(pedidoId)) throw new Error('pedido inválido');
    return `km:${ambiente}:creditos:${pedidoId}`;
}
const REFERENCIA = /^km:(sandbox|producao):creditos:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export function lerReferenciaExterna(v: unknown): { ambiente: 'sandbox' | 'producao'; pedidoId: string } | null {
    const m = typeof v === 'string' ? REFERENCIA.exec(v) : null;
    return m ? { ambiente: m[1] as 'sandbox' | 'producao', pedidoId: m[2] } : null;
}

// --- Lotes ----------------------------------------------------------------------------------------------------------
export type LoteSaldo = { id: string; origem: Origem; disponivel: number; venceEm: number };
const PRIORIDADE: Record<Origem, number> = { FRANQUIA: 0, CORTESIA: 1, LEGADO: 2, COMPRA: 3 };
/** Menor vencimento primeiro; no empate, franquia e cortesia antes do pago; por fim o id (ordem determinística). */
export function ordenarParaConsumo<T extends LoteSaldo>(lotes: readonly T[]): T[] {
    return [...lotes].sort((a, b) => a.venceEm - b.venceEm || PRIORIDADE[a.origem] - PRIORIDADE[b.origem] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/** Alocação congelada da reserva: consome lotes vigentes na ordem de consumo. null = saldo insuficiente. */
export function alocar(lotes: readonly LoteSaldo[], quantidade: number, agora: number): { loteId: string; quantidade: number }[] | null {
    if (!Number.isSafeInteger(quantidade) || quantidade <= 0) throw new Error('quantidade inválida');
    const r: { loteId: string; quantidade: number }[] = [];
    let falta = quantidade;
    for (const l of ordenarParaConsumo(lotes.filter((x) => x.disponivel > 0 && x.venceEm > agora))) {
        const q = Math.min(falta, l.disponivel);
        r.push({ loteId: l.id, quantidade: q });
        falta -= q;
        if (falta === 0) return r;
    }
    return null;
}

/** Fim do mês civil de São Paulo (instante UTC) do dia informado — validade da franquia e do lote legado. */
export function fimDoMesBrasilia(instante: number) {
    const [a, m] = dataBrasilia(instante).split('-').map(Number);
    const proximo = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01`;
    return Date.parse(`${proximo}T03:00:00Z`);
}
export const mesBrasilia = (instante: number) => `${dataBrasilia(instante).slice(0, 7)}-01`;
/** Vencimento de lote pago/cortesia: N dias a partir da liberação, no fim do dia de São Paulo. */
export function vencimentoEmDias(instante: number, dias: number) {
    return Date.parse(`${somarDias(dataBrasilia(instante), dias + 1)}T03:00:00Z`);
}
export const vencimentoPagamento = (instante: number, dias: number) => somarDias(dataBrasilia(instante), dias);

// --- Pagamento ------------------------------------------------------------------------------------------------------
/** Status do Asaas que liberam crédito (uma única vez). AUTHORIZED e aprovação de risco isolada não liberam. */
export const STATUS_LIBERA = new Set(['CONFIRMED', 'RECEIVED']);
export const STATUS_ESTORNO = new Set(['REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS']);
export const STATUS_DISPUTA = new Set(['CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE', 'AWAITING_CHARGEBACK_REVERSAL']);

export type LidoNoProvedor = { id: string; status: string; valorCentavos: number | null; clienteId: string | null; externalReference: string | null;
    billingType: string | null; deleted: boolean };
export type Esperado = { pagamentoId: string; valorCentavos: number; clienteId: string; referencia: string; forma: Forma };
export type Decisao =
    | { acao: 'CREDITAR' } | { acao: 'AGUARDAR' } | { acao: 'VENCIDO' } | { acao: 'CANCELADO' }
    | { acao: 'ESTORNO' } | { acao: 'DISPUTA' } | { acao: 'REVISAO'; motivo: string };

/**
 * Decide o efeito da leitura do provedor (nunca do conteúdo do webhook). Qualquer divergência de vínculo vai para
 * revisão: cobrança de outra conta/cliente/referência, valor diferente do esperado, forma diferente, dinheiro/manual.
 */
export function decidirPagamento(lido: LidoNoProvedor | null, esperado: Esperado): Decisao {
    if (!lido) return { acao: 'REVISAO', motivo: 'COBRANCA_NAO_ENCONTRADA' };
    if (lido.id !== esperado.pagamentoId) return { acao: 'REVISAO', motivo: 'ID_DIVERGENTE' };
    if (lido.externalReference !== esperado.referencia) return { acao: 'REVISAO', motivo: 'REFERENCIA_DIVERGENTE' };
    if (lido.clienteId !== esperado.clienteId) return { acao: 'REVISAO', motivo: 'CLIENTE_DIVERGENTE' };
    if (STATUS_DISPUTA.has(lido.status)) return { acao: 'DISPUTA' };
    if (STATUS_ESTORNO.has(lido.status)) return { acao: 'ESTORNO' };
    if (lido.status === 'RECEIVED_IN_CASH') return { acao: 'REVISAO', motivo: 'RECEBIDO_FORA_DO_PROVEDOR' };
    if (lido.deleted) return { acao: 'CANCELADO' };
    if (STATUS_LIBERA.has(lido.status)) {
        if (lido.valorCentavos !== esperado.valorCentavos) return { acao: 'REVISAO', motivo: 'VALOR_DIVERGENTE' };
        if (lido.billingType !== BILLING_TYPE[esperado.forma]) return { acao: 'REVISAO', motivo: 'FORMA_DIVERGENTE' };
        return { acao: 'CREDITAR' };
    }
    if (lido.status === 'OVERDUE') return { acao: 'VENCIDO' };
    return { acao: 'AGUARDAR' };
}

// --- Devolução de pacote (PROPOSTA de 22/10/2026, sujeita ao jurídico) ------------------------------------------------
export type TipoDevolucaoPacote = 'ARREPENDIMENTO_7_DIAS' | 'SALDO_NAO_UTILIZADO';
export type LoteParaDevolucao = { quantidade: number; disponivel: number; reservado: number; bloqueado: number; consumido: number; expirado: number; cancelado: number;
    liberadoEm: number; venceEm: number };
export type CalculoDevolucao = { tipo: TipoDevolucaoPacote; valorCentavos: number; quantidadeCancelada: number; quantidadeConsumida: number; prazo: string; garantiaAte: number };
export type OpcaoDevolucao = { disponivel: true; calculo: CalculoDevolucao } | { disponivel: false; motivo: string };

export const fimDaGarantiaPacote = (liberadoEm: number, dias = 7) => liberadoEm + dias * 86_400_000;

/** Arredondamento ao centavo (metade para cima) de pago × parte ÷ total, sem ponto flutuante. */
export function proporcionalCentavos(pagoCentavos: number, parte: number, total: number) {
    if (![pagoCentavos, parte, total].every((n) => Number.isSafeInteger(n) && n >= 0) || total <= 0 || parte > total) throw new Error('valores inválidos');
    const p = BigInt(pagoCentavos), a = BigInt(parte), t = BigInt(total);
    return Number((p * a * 2n + t) / (2n * t));
}

/**
 * Opções de devolução de um lote pago:
 *   - garantia de 7 dias desde a liberação: devolução INTEGRAL, mesmo com uso; bloqueia o remanescente e as reservas em
 *     andamento terminam sem reabrir crédito;
 *   - depois: devolução proporcional do saldo pago não utilizado, pelo preço unitário original, sem taxa; exige que não
 *     haja geração/chamada em andamento no lote (a pessoa espera a conclusão para o cálculo ser exato).
 * Lote vencido não devolve por esta regra (indisponibilidade imputável à plataforma é tratada à parte).
 */
export function opcaoDevolucao(lote: LoteParaDevolucao, precoCentavos: number, agora: number, devolucaoExistente: boolean, garantiaDias = 7): OpcaoDevolucao {
    if (devolucaoExistente) return { disponivel: false, motivo: 'DEVOLUCAO_JA_REGISTRADA' };
    if (lote.bloqueado > 0 || lote.cancelado > 0) return { disponivel: false, motivo: 'LOTE_BLOQUEADO' };
    const garantiaAte = fimDaGarantiaPacote(lote.liberadoEm, garantiaDias);
    const hoje = dataBrasilia(agora);
    if (agora < garantiaAte)
        return { disponivel: true, calculo: { tipo: 'ARREPENDIMENTO_7_DIAS', valorCentavos: precoCentavos, quantidadeCancelada: lote.disponivel,
            quantidadeConsumida: lote.consumido, prazo: hoje, garantiaAte } };
    if (agora >= lote.venceEm) return { disponivel: false, motivo: 'LOTE_VENCIDO' };
    if (lote.reservado > 0) return { disponivel: false, motivo: 'GERACAO_EM_ANDAMENTO' };
    if (lote.disponivel <= 0) return { disponivel: false, motivo: 'SEM_SALDO_PAGO' };
    const valor = proporcionalCentavos(precoCentavos, lote.disponivel, lote.quantidade);
    if (valor <= 0) return { disponivel: false, motivo: 'SEM_VALOR_A_DEVOLVER' };
    return { disponivel: true, calculo: { tipo: 'SALDO_NAO_UTILIZADO', valorCentavos: valor, quantidadeCancelada: lote.disponivel,
        quantidadeConsumida: lote.consumido, prazo: somarDiasUteis(hoje, 5), garantiaAte } };
}

// --- Exibição -------------------------------------------------------------------------------------------------------
/** Quantidade interna → exibida (Wall-e: µUS$ → créditos de US$ 0,001, arredondado para baixo; nunca mostra mais). */
export const exibir = (recurso: Recurso, quantidade: number) => (recurso === 'WALLE' ? Math.floor(quantidade / 1000) : quantidade);
/** Saldo baixo: abaixo de `percentual` da referência (última recarga/franquia), ou zerado. */
export function avisoSaldo(disponivel: number, referencia: number, percentual = 20): 'ZERADO' | 'BAIXO' | null {
    if (disponivel <= 0) return referencia > 0 ? 'ZERADO' : null;
    return referencia > 0 && disponivel * 100 < referencia * percentual ? 'BAIXO' : null;
}
