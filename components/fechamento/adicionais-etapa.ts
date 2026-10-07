/**
 * Etapa "Quer adicionar algo à festa?" — partes puras (testáveis sem React).
 *
 * Carregando ≠ erro ≠ pronto. Em erro, a etapa mostra só o aviso e "Tentar novamente": nenhum título de
 * categoria vazio, nenhum total e nenhum campo de personalização (que só faz sentido com adicionais).
 */
export type EstadoAdicionais = "carregando" | "erro" | "ok";

export type EscolhasDaEtapa = { max: number | null; itens: Array<{ id: string; nome: string }> };
export type AdicionalDaEtapa = { id: string; nome: string; categoria: string; preco: number; unidadeCobranca: string; codigo?: string; escolhas?: EscolhasDaEtapa };

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
    const escolhas = x?.escolhas;
    const escolhasValidas = escolhas === undefined || (!!escolhas && Array.isArray(escolhas.itens)
      && (escolhas.max === null || (Number.isInteger(escolhas.max) && escolhas.max >= 1))
      && escolhas.itens.every((i) => !!i && typeof i.id === "string" && typeof i.nome === "string"));
    return !!x && typeof x.id === "string" && typeof x.nome === "string" && typeof x.categoria === "string"
      && typeof x.preco === "number" && Number.isFinite(x.preco) && x.preco >= 0 && typeof x.unidadeCobranca === "string" && escolhasValidas;
  };
  return lista.every(valido) ? lista : null;
}

/** Só categorias com pelo menos um adicional, na ordem da tela. */
export function agruparPorCategoria(itens: readonly AdicionalDaEtapa[]): Array<{ categoria: CategoriaEtapa; titulo: string; itens: AdicionalDaEtapa[] }> {
  return (Object.keys(TITULOS) as CategoriaEtapa[])
    .map((categoria) => ({ categoria, titulo: TITULOS[categoria], itens: itens.filter((i) => (DA_CATEGORIA[i.categoria] ?? "extra") === categoria) }))
    .filter((g) => g.itens.length > 0);
}

/** Rótulo do preço conforme a unidade de cobrança ("" quando o valor já é o total). */
export function rotuloUnidade(unidade: string): string {
  return ({ UNIDADE: " / unidade extra", CENTO: " / cento", CONVIDADO: " / convidado", HORA: " / hora", METRO: " / metro" } as Record<string, string>)[unidade] ?? "";
}

/** Unidades em que o cliente informa quantas quer. */
export function aceitaQuantidade(unidade: string): boolean {
  return unidade === "UNIDADE" || unidade === "CENTO" || unidade === "HORA" || unidade === "METRO";
}

/** Mesmo cálculo do servidor: por convidado multiplica pelos convidados; os demais, pela quantidade. */
export function totalDoAdicional(item: Pick<AdicionalDaEtapa, "preco" | "unidadeCobranca">, quantidade: number, convidados: number): number {
  const vezes = item.unidadeCobranca === "CONVIDADO" ? convidados * quantidade : quantidade;
  return Math.round(item.preco * vezes * 100) / 100;
}

/** Pendência das escolhas de um adicional de categoria selecionado, ou null quando está ok. */
export function pendenciaEscolhas(item: AdicionalDaEtapa, escolhidos: readonly string[]): string | null {
  if (!item.escolhas) return null;
  if (escolhidos.length === 0) return `Escolha as opções de ${item.nome}.`;
  if (item.escolhas.max !== null && escolhidos.length > item.escolhas.max) return `Escolha no máximo ${item.escolhas.max} opções em ${item.nome}.`;
  return null;
}

/** Mensagem da falha na consulta, pelo código da API. */
export function mensagemFalhaAdicionais(codigo: string | undefined, admin = false): string {
  if (codigo === "PRECO_INDISPONIVEL") {
    return admin
      ? "Não há tabela de preços publicada para esta data. Publique em Configurações › Tabelas de preço."
      : "Os valores dos adicionais ainda não estão disponíveis para esta data. Fale com a equipe Kidmais.";
  }
  return "Não foi possível consultar os adicionais deste pacote.";
}
