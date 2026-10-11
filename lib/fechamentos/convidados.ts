import { erroConvidadosPizzaParty } from '../comercial/pacotes-v1.ts';
/** Atalhos de conveniência. Os limites do pacote continuam sendo oficiais. */
export const ATALHOS_CONVIDADOS = [20, 30, 40, 50, 60, 80, 100, 110, 120, 130, 140, 150] as const;
export function atalhosConvidados(minimo: number, maximo: number) {
    return ATALHOS_CONVIDADOS.filter(valor => valor >= minimo && valor <= maximo);
}

/** Mesma regra da etapa de convidados para a UI e a criação administrativa. */
export function erroConvidadosFechamento(quantidade: number, pacote?: {
    id: string; nome: string; minPagantes: number; maxPagantes: number;
}) {
    const erroPizza = erroConvidadosPizzaParty(pacote?.id ?? '', quantidade);
    if (erroPizza) return erroPizza;
    if (!Number.isInteger(quantidade) || quantidade <= 0) return 'Informe a quantidade de convidados pagantes.';
    if (quantidade > 150) return 'A Kidmais atende no máximo 150 convidados neste fechamento.';
    if (pacote && quantidade > pacote.maxPagantes) return `${pacote.nome} atende até ${pacote.maxPagantes} convidados neste pacote.`;
    if (pacote && quantidade < pacote.minPagantes) return `${pacote.nome} possui mínimo de ${pacote.minPagantes} pagantes.`;
    if (pacote?.id === 'compacta' && quantidade !== 40) return 'A Festa Compacta possui valor automático somente para 40 convidados. Para outra quantidade, consulte a equipe Kidmais.';
    return null;
}

/**
 * Endereço de outra empresa (/b/<código>): só o mínimo e o máximo do pacote dela, com redação neutra. As regras e
 * textos do catálogo da Kidmais (Festa Compacta, Pizza Party) não se aplicam; o servidor confere a cotação. O teto do pedido
 * online (`LIMITE_CONVIDADOS_PEDIDO_ONLINE`) é o mesmo do servidor (`comercial-schema`), com redação neutra.
 */
export const LIMITE_CONVIDADOS_PEDIDO_ONLINE = 150;
export function erroConvidadosEmpresa(quantidade: number, pacote?: { nome: string; minPagantes: number; maxPagantes: number; limiteCadastrado?: boolean }) {
    if (!Number.isInteger(quantidade) || quantidade <= 0) return 'Informe a quantidade de convidados pagantes.';
    if (quantidade > LIMITE_CONVIDADOS_PEDIDO_ONLINE) return `O pedido online aceita até ${LIMITE_CONVIDADOS_PEDIDO_ONLINE} convidados. Para mais, fale com o buffet.`;
    if (pacote && pacote.limiteCadastrado !== false && quantidade > pacote.maxPagantes) return `${pacote.nome} atende até ${pacote.maxPagantes} convidados neste pacote.`;
    if (pacote && quantidade < pacote.minPagantes) return `${pacote.nome} possui mínimo de ${pacote.minPagantes} pagantes.`;
    return null;
}
