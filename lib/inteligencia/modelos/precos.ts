import { z } from "zod";
import type { IdProvedor } from "../contratos.ts";
import type { Ambiente } from "../flags.ts";

/**
 * Pricing configurável. Nenhum preço de provedor fica no código: o valor muda com o tempo e
 * precisa ser conferido na página oficial do provedor antes de configurar.
 *
 * AI_PRICING_JSON = {
 *   "moeda": "USD",
 *   "modelos": { "OPENAI:<modelo>": { "entrada": 0.0, "saida": 0.0, "cache": 0.0 } }
 * }
 * Valores por 1 milhão de tokens, na moeda informada. Sem preço ⇒ custo `null` (desconhecido), nunca zero.
 */
const precoSchema = z.object({
  entrada: z.number().nonnegative().max(10_000),
  saida: z.number().nonnegative().max(10_000),
  cache: z.number().nonnegative().max(10_000).optional(),
}).strict();

const tabelaSchema = z.object({
  moeda: z.string().regex(/^[A-Z]{3}$/),
  modelos: z.record(z.string().regex(/^(OPENAI|DEEPSEEK|FAKE):[A-Za-z0-9._:\-/]{1,120}$/), precoSchema),
}).strict();

export type TabelaPrecos = z.infer<typeof tabelaSchema>;

/** JSON inválido ⇒ tabela vazia (custo desconhecido), nunca preço inventado. */
export function tabelaDoAmbiente(env: Ambiente): TabelaPrecos | null {
  const bruto = env.AI_PRICING_JSON;
  if (!bruto?.trim()) return null;
  try {
    const lido = tabelaSchema.safeParse(JSON.parse(bruto));
    return lido.success ? lido.data : null;
  } catch {
    return null;
  }
}

/** Custo em micro-unidades (1e-6) da moeda. Preço por 1M tokens × tokens = micro-unidades. */
export function custoEstimado(
  tabela: TabelaPrecos | null,
  provedor: IdProvedor,
  modelo: string,
  tokens: { entrada: number; saida: number; cache: number | null },
): { micros: number; moeda: string } | null {
  const preco = tabela?.modelos[`${provedor}:${modelo}`];
  if (!tabela || !preco) return null;
  const cache = Math.min(tokens.cache ?? 0, tokens.entrada);
  const micros = (tokens.entrada - cache) * preco.entrada + cache * (preco.cache ?? preco.entrada) + tokens.saida * preco.saida;
  return { micros: Math.round(micros), moeda: tabela.moeda };
}
