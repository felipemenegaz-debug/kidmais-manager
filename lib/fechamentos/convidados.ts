/** Atalhos de conveniência. Os limites do pacote continuam sendo oficiais. */
export const ATALHOS_CONVIDADOS = [20, 30, 40, 50, 60, 80, 100, 110, 120, 130, 140, 150] as const;
export function atalhosConvidados(minimo: number, maximo: number) {
    return ATALHOS_CONVIDADOS.filter(valor => valor >= minimo && valor <= maximo);
}

/** Mesma regra da etapa de convidados para a UI e a criação administrativa. */
export function erroConvidadosFechamento(quantidade: number, pacote?: {
    id: string; nome: string; minPagantes: number; maxPagantes: number;
}) {
    if (!Number.isInteger(quantidade) || quantidade <= 0) return 'Informe a quantidade de convidados pagantes.';
    if (quantidade > 150) return 'A Kidmais atende no máximo 150 convidados neste fechamento.';
    if (pacote && quantidade > pacote.maxPagantes) return `${pacote.nome} atende até ${pacote.maxPagantes} convidados neste pacote.`;
    if (pacote && quantidade < pacote.minPagantes) return `${pacote.nome} possui mínimo de ${pacote.minPagantes} pagantes.`;
    if (pacote?.id === 'compacta' && quantidade !== 40) return 'A Festa Compacta possui valor automático somente para 40 convidados. Para outra quantidade, consulte a equipe Kidmais.';
    return null;
}
