import { z } from "zod";
import type { EntidadeRef, TipoEntidade } from "./contratos.ts";

/**
 * Conversation Focus (AI V1.1, PR 5): as últimas entidades estruturadas da conversa, curtas e SEM autoridade.
 *
 * - A UI reenvia só `{ tipo, id }` (+ principal), como reenvia o contexto de tela: é DICA. O rótulo vai só para a UI.
 * - O servidor nunca usa um id do foco diretamente: cada uso passa por uma ferramenta do gateway (Policy + Tenant
 *   Context + posse/capacidade no domínio). Outra empresa ou inexistente ⇒ a entidade é descartada (fail-closed).
 * - Não há memória no servidor nem entre conversas: o foco vive no drawer da sessão da página.
 */
export const MAX_FOCO = 5;
export const TIPOS_ENTIDADE = ["FESTA", "CLIENTE", "CONTRATO", "ITEM", "CATEGORIA"] as const satisfies readonly TipoEntidade[];

/** Entrada (UI → servidor): estrita, sem rótulo, sem campos de autoridade. */
export const focoEntradaSchema = z.object({
  entidades: z.array(z.object({ tipo: z.enum(TIPOS_ENTIDADE), id: z.string().uuid() }).strict()).max(MAX_FOCO),
  principal: z.number().int().min(0).max(MAX_FOCO - 1).optional(),
}).strict();

export type FocoEntrada = z.infer<typeof focoEntradaSchema>;
export type OrigemFoco = "LEITURA" | "RELACAO" | "TELA" | "NAVEGACAO";
export type EntidadeFoco = { tipo: TipoEntidade; id: string; rotulo: string; origem: OrigemFoco };
/** Saída (servidor → UI). */
export type FocoConversa = { entidades: EntidadeFoco[]; principal: number | null };

/**
 * Novo foco: entidades novas primeiro (a principal é a primeira), depois as anteriores ainda válidas; sem repetição,
 * no máximo 5. `descartar` remove ids negados/inexistentes na revalidação. Resposta que é uma LISTA do mesmo tipo
 * (várias festas, várias categorias) não tem principal: "essa festa" depois dela é ambíguo, nunca a primeira da lista.
 */
export function atualizarFoco(novas: readonly (EntidadeRef & { origem?: OrigemFoco })[], anteriores: readonly EntidadeFoco[], descartar: ReadonlySet<string> = new Set(), comPrincipal = true): FocoConversa {
  const vistas = new Set<string>();
  const entidades: EntidadeFoco[] = [];
  for (const e of [...novas.map((n) => ({ tipo: n.tipo, id: n.id, rotulo: n.rotulo, origem: n.origem ?? ("LEITURA" as const) })), ...anteriores]) {
    const chave = `${e.tipo}:${e.id}`;
    if (vistas.has(chave) || descartar.has(e.id)) continue;
    vistas.add(chave);
    entidades.push(e);
    if (entidades.length >= MAX_FOCO) break;
  }
  return { entidades, principal: entidades.length && comPrincipal ? 0 : null };
}
