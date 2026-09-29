import type { DbExecutor } from "../../db/contracts.ts";
import type { SessaoParaTenant } from "../../saas/provar-tenant.ts";
import { ResumoTenantError, executarComPosseNoTenant, type ComTenant } from "./posse-tenant.ts";

/**
 * Exportações administrativas de contrato (PDF do contrato, PDF do Resumo, documento/comprovante) com
 * Tenant Context.
 *
 * Fluxo (D1): sessão → Tenant Context (provarTenant: usuário, empresa, membership e papel atual travados) →
 * consulta JÁ escopada pela empresa comprovada (fechamento E pacote com `empresa_id` da empresa comprovada, o
 * mesmo predicado de contrato-tenant.ts) → TODOS os dados do PDF lidos com o MESMO `tx` → revalidarTenant →
 * commit → só então a renderização, em memória, sem nova consulta. Nenhum byte é lido antes da prova nem
 * depois do commit, e a transação não fica aberta durante a renderização.
 *
 * Outra empresa, pacote legado (empresa nula) e inexistente: a mesma resposta 404 (`ResumoTenantError`).
 * A empresa nunca vem do pedido como prova; `empresaId` da query só escolhe entre memberships ativas.
 * Tenant não comprovado: `TENANT_NAO_COMPROVADO` (403), sem consulta de contrato.
 */

/** Id do contrato do fechamento, só se o fechamento for da empresa comprovada. */
export async function contratoDoFechamentoNoTenant(tx: DbExecutor, empresaId: string, fechamentoId: string): Promise<string | null> {
  const r = await tx.query<{ id: string }>(
    `SELECT contrato.id::text AS id
       FROM contratos contrato
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id AND fech.empresa_id = $2::uuid
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $2::uuid
      WHERE contrato.fechamento_id = $1::uuid
      LIMIT 1`,
    [fechamentoId, empresaId],
  );
  return r.rows[0]?.id ?? null;
}

/** O documento (contrato ou comprovante) é de uma versão de contrato da empresa comprovada? */
export async function documentoPertenceAoTenant(tx: DbExecutor, empresaId: string, documentoId: string): Promise<boolean> {
  const r = await tx.query<{ id: string }>(
    `SELECT doc.id::text AS id
       FROM contrato_documentos doc
       JOIN contrato_versoes ver ON ver.id = doc.contrato_versao_id
       JOIN contratos contrato ON contrato.id = ver.contrato_id
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id AND fech.empresa_id = $2::uuid
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $2::uuid
      WHERE doc.id = $1::uuid`,
    [documentoId, empresaId],
  );
  return r.rows.length === 1;
}

/** Posse para exportação: o fechamento tem contrato e ambos são da empresa comprovada. */
async function fechamentoComContratoNoTenant(tx: DbExecutor, empresaId: string, fechamentoId: string) {
  return (await contratoDoFechamentoNoTenant(tx, empresaId, fechamentoId)) !== null;
}

/**
 * PDF do contrato ou do Resumo por `fechamentoId`: prova e `adquirir` (todas as consultas) na mesma
 * transação; `renderizar` depois do commit, só em memória (recebe apenas os dados adquiridos).
 */
export async function exportarContratoDoTenant<A, R>(
  sessao: SessaoParaTenant,
  empresaSolicitada: string | null,
  fechamentoId: string,
  deps: { withTenantTransaction: ComTenant; adquirir(fechamentoId: string, tx: DbExecutor): Promise<A>; renderizar(dados: A): R },
): Promise<R> {
  const dados = await executarComPosseNoTenant(sessao, empresaSolicitada, fechamentoId, fechamentoComContratoNoTenant, deps, (tx) => deps.adquirir(fechamentoId, tx));
  return deps.renderizar(dados);
}

/** Documento persistido: prova de posse e leitura na MESMA transação do tenant (não muda em D1). */
export async function lerDocumentoDoTenant<D>(
  sessao: SessaoParaTenant,
  empresaSolicitada: string | null,
  documentoId: string,
  deps: { withTenantTransaction: ComTenant; ler(documentoId: string, tx: DbExecutor): Promise<D> },
): Promise<D> {
  return deps.withTenantTransaction(sessao, empresaSolicitada, async (tx, tenant) => {
    if (!await documentoPertenceAoTenant(tx, tenant.empresaComprovada, documentoId)) throw new ResumoTenantError();
    return deps.ler(documentoId, tx);
  });
}
