/**
 * Regras oficiais Kidmais de adicionais por pacote (puras, sem banco).
 *
 * - Lembrancinha: INCLUSA em Mini Festa Kidmais, Festa Completa e Festa Premium; é ADICIONAL em Pocket,
 *   Compacta e Essencial. Nos pacotes em que é inclusa, nunca aparece como adicional pago.
 * - Empratado premium: incluso SOMENTE na Festa Premium; não aparece como adicional para a Premium.
 * - Buffet: item incluído no pacote não aparece como adicional pago; só itens não inclusos ou extras
 *   permitidos (modalidade EXTRA no pacote).
 * - Modalidade INCLUSO ou INDISPONIVEL no pacote ⇒ nunca é oferecido como adicional.
 */
export const PACOTES_COM_LEMBRANCINHA_INCLUSA: readonly string[] = ["MINI_FESTA", "COMPLETA", "PREMIUM"];
export const PACOTES_COM_EMPRATADO_INCLUSO: readonly string[] = ["PREMIUM"];

export const ehLembrancinha = (codigo: string) => codigo.startsWith("LEMBRANCINHA_");
export const ehEmpratadoPremium = (codigo: string) => codigo === "EMPRATADO_PREMIUM";

export type AdicionalCandidato = { codigo: string; modalidade: "INCLUSO" | "EXTRA" | "INDISPONIVEL" };

export type Exclusao = "INCLUSO_NO_PACOTE" | "INDISPONIVEL_NO_PACOTE" | "LEMBRANCINHA_INCLUSA" | "EMPRATADO_INCLUSO" | "ITEM_DO_BUFFET_INCLUSO";

/** Motivo de o adicional NÃO ser oferecido, ou null quando é elegível como adicional pago. */
export function motivoDeExclusao(pacoteCodigo: string, adicional: AdicionalCandidato, itensInclusosNoBuffet: ReadonlySet<string> = new Set()): Exclusao | null {
  if (adicional.modalidade === "INCLUSO") return "INCLUSO_NO_PACOTE";
  if (adicional.modalidade === "INDISPONIVEL") return "INDISPONIVEL_NO_PACOTE";
  if (ehLembrancinha(adicional.codigo) && PACOTES_COM_LEMBRANCINHA_INCLUSA.includes(pacoteCodigo)) return "LEMBRANCINHA_INCLUSA";
  if (ehEmpratadoPremium(adicional.codigo) && PACOTES_COM_EMPRATADO_INCLUSO.includes(pacoteCodigo)) return "EMPRATADO_INCLUSO";
  if (itensInclusosNoBuffet.has(adicional.codigo)) return "ITEM_DO_BUFFET_INCLUSO";
  return null;
}

export function filtrarAdicionaisElegiveis<T extends AdicionalCandidato>(pacoteCodigo: string, adicionais: readonly T[], itensInclusosNoBuffet: ReadonlySet<string> = new Set()): T[] {
  return adicionais.filter((a) => motivoDeExclusao(pacoteCodigo, a, itensInclusosNoBuffet) === null);
}
