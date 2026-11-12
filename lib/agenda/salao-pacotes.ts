import type { DbExecutor } from "../db/contracts.ts";

/**
 * O que os pacotes ligados a um salão oferecem (R2-8 do plano S-A/S-A2, 25/10/2026). Antes de o cliente escolher o
 * pacote, só o que está em TODOS os pacotes do salão pode ser dito como garantido; o resto "varia conforme o pacote".
 *   * pacotes elegíveis (S-D, R-D2: o MESMO universo da contratação, `pacotesElegiveisDoSalao`): da empresa, ativos,
 *     vigentes, não arquivados e ligados ao salão (pacote_saloes) OU sem nenhum vínculo (regra da 093: serve a todos);
 *   * GARANTIDOS: itens fixos do pacote (pacote_itens_especificos, item ativo) e adicionais INCLUSO ativos — inclusive
 *     os da categoria SERVICOS (103). Identidade tipada (tipo + id), nunca nome; contagem por pacote distinto;
 *   * OPÇÕES de cardápio: categorias ativas com o conjunto efetivo (TODOS_ATIVOS = itens ativos da categoria;
 *     SELECIONADOS = os escolhidos e ativos) e as faixas de escolha POR PACOTE. Nunca viram "em todos os pacotes";
 *   * mesma regra de atividade da composição do Wall-e e do formulário do cliente.
 */
export type ItemGarantido = { chave: string; tipo: "BUFFET_ITEM" | "ADICIONAL"; nome: string; categoria: string | null; pacotes: number };
export type OpcaoCardapio = { pacoteId: string; pacote: string; categoria: string; escolhasMin: number; escolhasMax: number; itens: string[] };

/**
 * S-D (R-D2): SQL dos pacotes elegíveis do salão ($1 empresa, $2 salão) — usado pelo texto público ("em todos os pacotes
 * deste salão"), pelo filtro do assistente e pela conferência do envio. Salão de outra empresa: nenhum vínculo vale.
 */
export const SQL_PACOTES_ELEGIVEIS_DO_SALAO = `SELECT p.id FROM pacotes p
                     WHERE p.empresa_id = $1::uuid AND p.ativo AND p.vigente AND p.arquivado_em IS NULL
                       AND EXISTS (SELECT 1 FROM agenda_saloes s WHERE s.id = $2::uuid AND s.empresa_id = p.empresa_id)
                       AND (EXISTS (SELECT 1 FROM pacote_saloes ps WHERE ps.pacote_id = p.id AND ps.salao_id = $2::uuid)
                            OR NOT EXISTS (SELECT 1 FROM pacote_saloes ps WHERE ps.pacote_id = p.id))`;

/** S-D (R-D2): ids dos pacotes elegíveis do salão. */
export async function pacotesElegiveisDoSalao(db: DbExecutor, empresaId: string, salaoId: string): Promise<string[]> {
  return (await db.query<{ id: string }>(`SELECT id::text AS id FROM (${SQL_PACOTES_ELEGIVEIS_DO_SALAO}) e ORDER BY id`, [empresaId, salaoId])).rows.map((r) => r.id);
}

export async function itensDosPacotesDoSalao(db: DbExecutor, empresaId: string, salaoId: string) {
  const elegiveis = SQL_PACOTES_ELEGIVEIS_DO_SALAO;
  const total = Number((await db.query<{ n: number }>(`SELECT count(DISTINCT id)::int AS n FROM (${elegiveis}) e`, [empresaId, salaoId])).rows[0]?.n ?? 0);
  if (total === 0) return { pacotes: 0, garantidos: [] as ItemGarantido[], emTodos: [] as ItemGarantido[], opcoes: [] as OpcaoCardapio[] };
  const garantidos = (await db.query<{ chave: string; tipo: "BUFFET_ITEM" | "ADICIONAL"; nome: string; categoria: string | null; pacotes: number }>(
    `WITH e AS (${elegiveis}),
     g AS (
       SELECT 'BUFFET_ITEM:' || b.id AS chave, 'BUFFET_ITEM' AS tipo, b.nome, NULL::text AS categoria, x.pacote_id
         FROM pacote_itens_especificos x JOIN buffet_itens b ON b.id = x.item_id AND b.ativo AND b.arquivado_em IS NULL
        WHERE x.pacote_id IN (SELECT id FROM e)
       UNION ALL
       SELECT 'ADICIONAL:' || a.id, 'ADICIONAL', a.nome, a.categoria, pa.pacote_id
         FROM pacote_adicionais pa JOIN adicionais a ON a.id = pa.adicional_id AND a.ativo AND (a.empresa_id IS NULL OR a.empresa_id = $1::uuid)
        WHERE pa.pacote_id IN (SELECT id FROM e) AND pa.ativo AND pa.modalidade = 'INCLUSO'
     )
     SELECT chave, tipo, min(nome) AS nome, min(categoria) AS categoria, count(DISTINCT pacote_id)::int AS pacotes
       FROM g GROUP BY chave, tipo ORDER BY count(DISTINCT pacote_id) DESC, min(nome)`, [empresaId, salaoId])).rows;
  const opcoes = (await db.query<{ pacote_id: string; pacote: string; categoria: string; escolhas_min: number; escolhas_max: number; itens: string[] | null }>(
    `SELECT p.id::text AS pacote_id, p.nome AS pacote, c.nome AS categoria, r.escolhas_min, r.escolhas_max,
            array_agg(i.nome ORDER BY i.ordem_exibicao, i.nome) FILTER (WHERE i.id IS NOT NULL) AS itens
       FROM pacotes p JOIN pacote_buffet_categorias r ON r.pacote_id = p.id AND r.ativo
       JOIN buffet_categorias c ON c.id = r.categoria_id AND c.ativo
       LEFT JOIN buffet_itens i ON i.categoria_id = c.id AND i.ativo
            AND (r.modo_itens = 'TODOS_ATIVOS' OR EXISTS (SELECT 1 FROM pacote_buffet_itens x WHERE x.pacote_id = r.pacote_id AND x.categoria_id = c.id AND x.item_id = i.id))
      WHERE p.id IN (${elegiveis})
      GROUP BY p.id, p.nome, p.ordem_exibicao, c.id, c.nome, c.ordem_exibicao, r.escolhas_min, r.escolhas_max
      ORDER BY p.ordem_exibicao, p.nome, c.ordem_exibicao, c.nome`, [empresaId, salaoId])).rows;
  const lista = garantidos.map((g) => ({ ...g, pacotes: Number(g.pacotes) }));
  return {
    pacotes: total,
    garantidos: lista,
    emTodos: lista.filter((g) => g.pacotes === total),
    opcoes: opcoes.map((o): OpcaoCardapio => ({
      pacoteId: o.pacote_id, pacote: o.pacote, categoria: o.categoria, escolhasMin: Number(o.escolhas_min), escolhasMax: Number(o.escolhas_max), itens: o.itens ?? [],
    })),
  };
}
