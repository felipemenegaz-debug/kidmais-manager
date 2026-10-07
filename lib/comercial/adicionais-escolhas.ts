import type { DbExecutor } from "../db/contracts.ts";
import { migration070Aplicada } from "./migration-070.ts";
import { PricingServiceError } from "./services/errors.ts";

/** Prefixo das escolhas congeladas em fechamento_adicionais.observacoes; o contrato imprime essa linha. */
export const PREFIXO_ESCOLHAS = "Escolhas: ";
export const ESCOLHAS_A_DEFINIR = `${PREFIXO_ESCOLHAS}a definir com a equipe`;

/**
 * Confere as escolhas de cada adicional precificado e devolve o texto congelado por adicionalId.
 * Adicional de categoria do buffet (070): até `escolhas_max` itens ATIVOS daquela categoria; nenhum = "a definir".
 * Qualquer outro adicional não aceita escolhas.
 */
export async function observacoesDasEscolhas(
  tx: DbExecutor,
  precificados: ReadonlyArray<{ adicionalId: string; codigo: string; nome: string }>,
  selecoes: ReadonlyArray<{ codigo: string; escolhas?: string[] }>,
): Promise<Map<string, string>> {
  const resultado = new Map<string, string>();
  const escolhasPorCodigo = new Map(selecoes.map((s) => [s.codigo.trim().toUpperCase(), [...new Set(s.escolhas ?? [])]]));
  const algumaEscolha = [...escolhasPorCodigo.values()].some((e) => e.length > 0);
  if (!precificados.length) return resultado;
  if (!(await migration070Aplicada(tx))) {
    if (algumaEscolha) throw new PricingServiceError("ESCOLHAS_INVALIDAS", "Este adicional não aceita escolhas.", 409);
    return resultado;
  }
  const origens = await tx.query<{ id: string; categoria: string | null; max: number | null }>(
    `SELECT id::text AS id, origem_buffet_categoria_id::text AS categoria, escolhas_max AS max
       FROM adicionais WHERE id = ANY($1::uuid[])`,
    [precificados.map((p) => p.adicionalId)],
  );
  const porId = new Map(origens.rows.map((o) => [o.id, o]));
  for (const item of precificados) {
    const escolhas = escolhasPorCodigo.get(item.codigo) ?? [];
    const origem = porId.get(item.adicionalId);
    if (!origem?.categoria) {
      if (escolhas.length) throw new PricingServiceError("ESCOLHAS_INVALIDAS", `${item.nome} não aceita escolhas.`, 409);
      continue;
    }
    if (!escolhas.length) {
      resultado.set(item.adicionalId, ESCOLHAS_A_DEFINIR);
      continue;
    }
    if (origem.max != null && escolhas.length > Number(origem.max)) {
      throw new PricingServiceError("ESCOLHAS_INVALIDAS", `Escolha no máximo ${origem.max} opções em ${item.nome}.`, 409);
    }
    const itens = await tx.query<{ id: string; nome: string }>(
      `SELECT id::text AS id, nome FROM buffet_itens
        WHERE id = ANY($1::uuid[]) AND categoria_id = $2::uuid AND ativo`,
      [escolhas, origem.categoria],
    );
    if (itens.rows.length !== escolhas.length) {
      throw new PricingServiceError("ESCOLHAS_INVALIDAS", `Uma das opções de ${item.nome} não está disponível.`, 409);
    }
    const nomes = new Map(itens.rows.map((i) => [i.id, i.nome]));
    resultado.set(item.adicionalId, PREFIXO_ESCOLHAS + escolhas.map((id) => nomes.get(id)).join(", "));
  }
  return resultado;
}
