import type { DbExecutor } from "../../db/contracts.ts";
import type { SessaoParaTenant } from "../../saas/provar-tenant.ts";
import { ResumoTenantError, executarComPosseNoTenant, type ComTenant } from "./posse-tenant.ts";

export { ResumoTenantError };

/**
 * Dados do Resumo da Contratação (tela e PDF) com Tenant Context (H9, D1).
 *
 * Fluxo: sessão → Tenant Context (provarTenant: usuário, empresa, membership e papel atual travados) → o
 * contrato pertence à empresa comprovada? → painel e financeiro lidos com o MESMO `tx` → revalidarTenant →
 * commit. Nenhuma leitura sensível depois do commit: revogar a membership, suspender a empresa ou trocar o
 * papel durante a leitura espera o commit (ou a leitura espera a revogação e é recusada).
 *
 * Pertencer = contrato → fechamento com `empresa_id` da empresa comprovada (o predicado de
 * `contratoDoTenant`) E pacote com a mesma `empresa_id` (o do Dashboard). Legado (empresa nula) não
 * pertence a ninguém.
 * Contrato de outra empresa, legado ou inexistente: a mesma resposta 404, sem distinguir.
 * A empresa do contrato nunca é aceita do pedido como prova: só o tenant comprovado vale.
 */
export async function contratoPertenceAoTenant(tx: DbExecutor, empresaId: string, contratoId: string) {
  const r = await tx.query<{ id: string }>(
    `SELECT contrato.id::text AS id
       FROM contratos contrato
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id AND fech.empresa_id = $2::uuid
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $2::uuid
      WHERE contrato.id = $1::uuid`,
    [contratoId, empresaId],
  );
  return r.rows.length === 1;
}

export type DependenciasResumoTenant<P, F> = {
  withTenantTransaction: ComTenant;
  /** `detalheAdministrativo` (painel de versões, fluxo, assinaturas, financeiro resumido), no `tx` da prova. */
  painel(contratoId: string, tx: DbExecutor): Promise<P>;
  /** `consultarPainelFinanceiro`, no `tx` da prova. */
  financeiro(contratoId: string, tx: DbExecutor): Promise<F>;
};

export async function resumoContratacaoDoTenant<P extends { financeiro?: readonly unknown[] }, F>(
  sessao: SessaoParaTenant,
  empresaSolicitada: string | null,
  contratoId: string,
  deps: DependenciasResumoTenant<P, F>,
): Promise<{ painel: P; financeiro: F | null }> {
  return executarComPosseNoTenant(sessao, empresaSolicitada, contratoId, contratoPertenceAoTenant, deps, async (tx) => {
    const painel = await deps.painel(contratoId, tx);
    const financeiro = painel.financeiro?.length ? await deps.financeiro(contratoId, tx) : null;
    return { painel, financeiro };
  });
}
