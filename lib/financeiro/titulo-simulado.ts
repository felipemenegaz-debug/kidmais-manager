/**
 * Colunas de RECEBER_SQL além das da parcela, para testes e benchmark que simulam o banco: pagamento aberto, sem
 * cronograma, estorno ou devolução, com obrigação alta o bastante para não limitar o saldo das parcelas simuladas.
 */
export function posicaoSimulada() {
  return {
    status_pagamento: "AGUARDANDO_PAGAMENTO",
    status_contrato: "ASSINADO",
    cronograma_id: null,
    item_id: null,
    item_saldo_inicial: null,
    item_recebido_base: null,
    item_estornado_base: null,
    item_vencimento: null,
    estornado: "0",
    pos_contratado: "99999999.00",
    pos_ajustes_centavos: "0",
    pos_recebido: "0",
    pos_estornado: "0",
    pos_devolvido_centavos: "0",
  };
}
