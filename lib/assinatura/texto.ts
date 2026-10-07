/** Duração em dias com singular/plural ("1 dia", "15 dias"). Função pura, usada nas telas públicas do teste grátis. */
export function dias(n: number): string {
    return n === 1 ? '1 dia' : `${n} dias`;
}
