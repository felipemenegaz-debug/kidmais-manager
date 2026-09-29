/**
 * Etapa "Quer adicionar algo à festa?" — partes puras (testáveis sem React).
 *
 * Carregando ≠ erro ≠ pronto. Em erro, a etapa mostra só o aviso e "Tentar novamente": nenhum título de
 * categoria vazio, nenhum total e nenhum campo de personalização (que só faz sentido com adicionais).
 */
export type EstadoAdicionais = "carregando" | "erro" | "ok";

export type AdicionalDaEtapa = { id: string; nome: string; categoria: string; preco: number; unidadeCobranca: string; codigo?: string };

export type CategoriaEtapa = "buffet" | "mesa" | "decoracao" | "extra";

export const TITULOS: Readonly<Record<CategoriaEtapa, string>> = {
  buffet: "Adicionais de buffet",
  mesa: "Mesas especiais",
  decoracao: "Decoração e extras",
  extra: "Outros adicionais",
};

const DA_CATEGORIA: Readonly<Record<string, CategoriaEtapa>> = { BUFFET: "buffet", MESA: "mesa", DECORACAO: "decoracao", EXTRA: "extra", BEBIDA: "extra", COMBO: "extra" };

/** Valida a resposta da API. Qualquer formato inesperado é tratado como erro (nunca lista parcial). */
export function lerAdicionaisDisponiveis(corpo: unknown): AdicionalDaEtapa[] | null {
  const lista = (corpo as { adicionais?: unknown } | null)?.adicionais;
  if (!Array.isArray(lista)) return null;
  const valido = (a: unknown): a is AdicionalDaEtapa => {
    const x = a as Partial<AdicionalDaEtapa> | null;
    return !!x && typeof x.id === "string" && typeof x.nome === "string" && typeof x.categoria === "string"
      && typeof x.preco === "number" && Number.isFinite(x.preco) && x.preco >= 0 && typeof x.unidadeCobranca === "string";
  };
  return lista.every(valido) ? lista : null;
}

/** Só categorias com pelo menos um adicional, na ordem da tela. */
export function agruparPorCategoria(itens: readonly AdicionalDaEtapa[]): Array<{ categoria: CategoriaEtapa; titulo: string; itens: AdicionalDaEtapa[] }> {
  return (Object.keys(TITULOS) as CategoriaEtapa[])
    .map((categoria) => ({ categoria, titulo: TITULOS[categoria], itens: itens.filter((i) => (DA_CATEGORIA[i.categoria] ?? "extra") === categoria) }))
    .filter((g) => g.itens.length > 0);
}
