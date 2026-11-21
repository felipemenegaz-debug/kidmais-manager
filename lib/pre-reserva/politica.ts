export const POLITICA_PRE_RESERVA = {
  sinalPadraoCentavos: 10000,
  sinalMinimoCentavos: 1000,
  sinalMaximoCentavos: 50000,
  validadeHoras: 48,
  prazoDevolucao: 'em até 2 dias úteis',
} as const;

/** O fechamento sem oferta segue disponível, inclusive quando o total não alcança o piso. */
export function sinalDaOferta(habilitada: boolean, orcamentoOnline: boolean, sinalCentavos: number, precoAceitoCentavos: number) {
  const { sinalMinimoCentavos: piso, sinalMaximoCentavos: teto } = POLITICA_PRE_RESERVA;
  if (!habilitada || !orcamentoOnline || !Number.isSafeInteger(precoAceitoCentavos) || precoAceitoCentavos < piso ||
      !Number.isInteger(sinalCentavos) || sinalCentavos < piso || sinalCentavos > teto) return null;
  return Math.min(sinalCentavos, precoAceitoCentavos);
}

/** O sufixo do identificador do extrato distingue maiúsculas de minúsculas. */
export function referenciaTransferencia(valor: string): string {
  const referencia = valor.trim();
  if (!/^E[0-9]{20}[A-Za-z0-9]{11}$/.test(referencia)) throw new Error('Informe o EndToEndId completo do Pix recebido.');
  return referencia;
}

export function garantiaAte(confirmadoEm: Date): Date {
  return new Date(confirmadoEm.getTime() + POLITICA_PRE_RESERVA.validadeHoras * 3_600_000);
}
