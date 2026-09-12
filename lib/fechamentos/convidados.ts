/** Atalhos de conveniência. Os limites do pacote continuam sendo oficiais. */
export const ATALHOS_CONVIDADOS = [20, 30, 40, 50, 60, 80, 100, 110, 120, 130, 140, 150] as const;
export function atalhosConvidados(minimo: number, maximo: number) {
    return ATALHOS_CONVIDADOS.filter(valor => valor >= minimo && valor <= maximo);
}
