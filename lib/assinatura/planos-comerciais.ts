/**
 * Oferta aprovada para novos contratos. Compartilhada com a vitrine, sem banco ou efeitos.
 * Não substitui o preço do legado UNICO nem habilita checkout/recursos por si só.
 * Condição Fundador só poderá ser usada pelo checkout após concessão persistida no servidor.
 */
export const condicoesComerciais = {
    versao: '2026-10-09',
    testeDias: 15,
    multiplicadorAnual: 10,
    fundador: { descontoPercentual: 40, meses: 12, vagas: 20 },
} as const;

export const planosComerciais = {
    essencial: { nome: 'Essencial', mensalCentavos: 19700, limiteUsuarios: 3 },
    profissional: { nome: 'Profissional', mensalCentavos: 34700, limiteUsuarios: 10 },
    premium: { nome: 'Premium', mensalCentavos: 59700, limiteUsuarios: null },
} as const;

export type PlanoComercialId = keyof typeof planosComerciais;
export type CicloComercial = 'mensal' | 'anual';

export function planoComercialValido(valor: unknown): valor is PlanoComercialId {
    return typeof valor === 'string' && Object.hasOwn(planosComerciais, valor);
}

/** Cálculo, não autorização de desconto. Não receber a condição diretamente do navegador. */
export function valorComercial(plano: PlanoComercialId, ciclo: CicloComercial, fundador = false): number {
    if (!planoComercialValido(plano) || (ciclo !== 'mensal' && ciclo !== 'anual'))
        throw new Error('Plano ou ciclo comercial inválido.');
    if (typeof fundador !== 'boolean')
        throw new Error('Condição comercial inválida.');
    const base = planosComerciais[plano].mensalCentavos * (ciclo === 'anual' ? condicoesComerciais.multiplicadorAnual : 1);
    return Math.round(base * (fundador ? 100 - condicoesComerciais.fundador.descontoPercentual : 100) / 100);
}
