/** Predicado comum às leituras de opções. Os aliases r, c e i são a regra, a categoria e o item. */
export const ITEM_DE_ESCOLHA_SQL = `(r.modo_itens='TODOS_ATIVOS' OR EXISTS
  (SELECT 1 FROM pacote_buffet_itens x WHERE x.pacote_id=r.pacote_id AND x.categoria_id=c.id AND x.item_id=i.id))`;
