/** Encerrar cobrança não decide retenção, crédito nem devolução do valor recebido. */
export function situacaoCobranca(statusContrato: string, statusPagamento: string, quantidadeRecebimentos: number, saldo: bigint) {
  const encerrada = statusContrato === 'CANCELADO' || statusPagamento === 'CANCELADO';
  return { encerrada, saldoACobrar: encerrada ? 0n : saldo,
    acertoAdministrativoPendente: encerrada && quantidadeRecebimentos > 0 };
}
