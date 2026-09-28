import type { DbExecutor } from "../db/contracts.ts";
import type { TenantComprovado } from "../saas/provar-tenant.ts";
import { atencaoHoje } from "./atencao-hoje.ts";

/** READ executa; SUGGEST/CONFIRM/DENY existem só para a política recusar enquanto a V1 for somente leitura. */
export type ClasseFerramenta = "READ" | "SUGGEST" | "CONFIRM" | "DENY";

export type ContextoFerramenta = {
  /** Data de referência em America/Sao_Paulo, calculada no servidor. */
  hoje: string;
  geradoEm: string;
};

export type ResultadoFerramenta = { estado: string; itens: readonly unknown[] };

export type ExecucaoFerramenta<R extends ResultadoFerramenta> = (
  tx: DbExecutor,
  tenant: TenantComprovado,
  contexto: ContextoFerramenta,
) => Promise<R>;

/**
 * A ferramenta nunca recebe SQL nem empresa do pedido.
 * `preparar` valida os parâmetros (schema estrito) antes de qualquer transação;
 * a execução só recebe a transação e o tenant já comprovados e chama serviços de domínio.
 */
export type Ferramenta<R extends ResultadoFerramenta = ResultadoFerramenta> = {
  nome: string;
  classe: ClasseFerramenta;
  /** Papéis que já acessam a mesma informação nas telas atuais. A IA não amplia esse conjunto. */
  papeis: readonly string[];
  preparar(parametros: unknown): ExecucaoFerramenta<R>;
};

/** Registro fechado: só o que está aqui pode ser executado pelo gateway. */
export const ferramentas: Readonly<Record<string, Ferramenta>> = Object.freeze({
  atencao_hoje: atencaoHoje,
});

export function ferramentaRegistrada(nome: string): Ferramenta | null {
  return Object.hasOwn(ferramentas, nome) ? ferramentas[nome] : null;
}
