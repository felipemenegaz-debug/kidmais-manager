import type { DbExecutor } from "../db/contracts.ts";

/**
 * Leitura do catálogo do Buffet (AI V1.1, PR 4), somente leitura. O catálogo é global hoje (sem empresa_id):
 * a mesma lista que qualquer membership vê em Configurações › Itens do Buffet. Só itens/categorias ativos.
 * A escrita continua fora daqui (catalogo-buffet.ts, sem autoridade de membership).
 */
export type CategoriaCatalogo = { id: string; nome: string };
export type ItemCatalogo = { id: string; nome: string; categoriaId: string | null; categoria: string | null };

export type FiltroCatalogo = { termo: string | null; categoria: string | null; limite: number };

/** Termo e categoria são literais de busca (ILIKE com escape), nunca SQL. */
export const padraoBusca = (termo: string | null) => (termo ? `%${termo.replace(/[\\%_]/g, (c) => "\\" + c)}%` : null);
const padrao = padraoBusca;

export async function buscarCategoriasBuffet(tx: DbExecutor, filtro: FiltroCatalogo): Promise<CategoriaCatalogo[]> {
  const r = await tx.query<{ id: string; nome: string }>(
    `SELECT id::text AS id, nome FROM buffet_categorias
      WHERE ativo AND ($1::text IS NULL OR nome ILIKE $1)
      ORDER BY ordem_exibicao, nome
      LIMIT $2`,
    [padrao(filtro.termo ?? filtro.categoria), Math.max(1, Math.min(filtro.limite, 50))],
  );
  return r.rows.map((l) => ({ id: l.id, nome: l.nome }));
}

export async function buscarItensBuffet(tx: DbExecutor, filtro: FiltroCatalogo): Promise<ItemCatalogo[]> {
  const r = await tx.query<{ id: string; nome: string; categoria_id: string | null; categoria: string | null }>(
    `SELECT item.id::text AS id, item.nome, categoria.id::text AS categoria_id, categoria.nome AS categoria
       FROM buffet_itens item
       LEFT JOIN buffet_categorias categoria ON categoria.id = item.categoria_id
      WHERE item.ativo
        AND ($1::text IS NULL OR item.nome ILIKE $1)
        AND ($2::text IS NULL OR categoria.nome ILIKE $2)
      ORDER BY categoria.ordem_exibicao NULLS LAST, item.ordem_exibicao, item.nome
      LIMIT $3`,
    [padrao(filtro.termo), padrao(filtro.categoria), Math.max(1, Math.min(filtro.limite, 50))],
  );
  return r.rows.map((l) => ({ id: l.id, nome: l.nome, categoriaId: l.categoria_id, categoria: l.categoria }));
}
