import type { AssinaturaProvedor, CobrancaProvedor } from './asaas.ts';
import { cicloDoProvedor } from './asaas.ts';
import type { Oferta } from './ofertas.ts';

/** Prova reconsultada no provedor. Conteúdo de webhook/retorno do navegador não é aceito aqui. */
export function pagamentoDaOferta(oferta: Oferta, assinatura: AssinaturaProvedor | null, pagamentos: readonly CobrancaProvedor[], clienteId: string | null, beneficioFim: string | null = null) {
    if (!assinatura || assinatura.externalReference !== oferta.empresa_id || !clienteId || assinatura.customer !== clienteId
        || cicloDoProvedor(assinatura.cycle) !== oferta.ciclo) return null;
    const quitadas = pagamentos.filter(p => !p.deleted && ['RECEIVED','CONFIRMED','RECEIVED_IN_CASH'].includes(p.status))
        .sort((a,b) => b.dueDate.localeCompare(a.dueDate) || b.id.localeCompare(a.id));
    const pagamento = quitadas[0];
    if (!pagamento || !['RECEIVED','CONFIRMED'].includes(pagamento.status)
        || pagamento.assinaturaId !== assinatura.id || pagamento.clienteId !== clienteId
        || !/^\d{4}-\d{2}-\d{2}$/.test(pagamento.dueDate)
        || !Number.isFinite(Date.parse(pagamento.dueDate))
        || new Date(pagamento.dueDate).toISOString().slice(0,10) !== pagamento.dueDate) return null;
    // Na renovação, o vencimento define a faixa de preço; pagar tarde não prolonga o desconto.
    const regular = (beneficioFim && pagamento.dueDate >= beneficioFim.slice(0,10))
        || (oferta.ciclo === 'ANUAL' && oferta.estado === 'CONFIRMADA'
            && pagamento.id !== oferta.pagamento_confirmacao_id);
    const esperado = regular ? oferta.valor_regular_centavos : oferta.valor_final_centavos;
    if (pagamento.valorCentavos !== esperado) return null;
    return pagamento;
}
