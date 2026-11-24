/**
 * Ordem das parcelas futuras do painel financeiro (achado P1 de 23/11/2026, festa F5 Theo).
 *
 * As parcelas eram lidas com `ORDER BY pp.id` (UUID aleatório), então o `futuro` do painel saía fora da ordem dos
 * vencimentos: o topo de Pagamentos dizia "Próxima parcela: R$ 2.000,00 em 23/01/2027" com a de 23/12/2026 ainda em
 * aberto (saldo R$ 1.200,00), e a programação e o seletor de recebimento numeravam "Parcela 2 · 2027-01-23".
 *
 * Sem dependências: usado pelo repositório (servidor) e pela tela (cliente).
 */
export type ItemFuturo = { vencimento: string; valorCentavos: string };

/**
 * Cópia ordenada por vencimento (AAAA-MM-DD), do mais cedo ao mais tarde. No empate de data, vale `desempate`
 * (por exemplo o número da parcela) e, por fim, a ordem recebida (a ordenação do JavaScript é estável).
 */
export function ordenarFuturoPorVencimento<T extends { vencimento: string }>(itens: readonly T[], desempate?: (item: T) => number): T[] {
  return [...itens].sort((a, b) => (a.vencimento < b.vencimento ? -1 : a.vencimento > b.vencimento ? 1 : desempate ? desempate(a) - desempate(b) : 0));
}

/** Próxima parcela: a de vencimento mais cedo entre as que ainda têm saldo, com o saldo restante dela. */
export function proximaParcelaEmAberto<T extends ItemFuturo>(futuro: readonly T[]): T | undefined {
  return ordenarFuturoPorVencimento(futuro.filter((item) => BigInt(item.valorCentavos) > 0n))[0];
}
