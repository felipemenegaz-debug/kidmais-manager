import type { DbExecutor } from "../../db/contracts.ts";
import { contratoPertenceAoTenant } from "./resumo-tenant.ts";
import { PAPEIS_ADMINISTRATIVOS, executarComPosseNoTenant, type ProvaDePosse } from "./posse-tenant.ts";

export { PAPEIS_ADMINISTRATIVOS, executarComPosseNoTenant, type ProvaDePosse };

/**
 * Tenant Context das rotas administrativas de contrato (B2): painel/lista, detalhe, financeiro por
 * `contratoId` (leituras, ações e comprovantes de devolução) e contrato por `fechamentoId`.
 *
 * Fluxo (D1): sessão → Tenant Context (provarTenant) → papel atual → consulta de posse com a empresa
 * comprovada NO WHERE → o serviço existente lê, trava ou grava com o MESMO `tx` → revalidarTenant → commit
 * (`executarComPosseNoTenant`, em posse-tenant.ts). Nenhuma leitura sensível, lock ou mutação acontece antes
 * da prova nem depois do commit. O id do recurso nunca define o tenant; `empresaId` da query só escolhe
 * entre memberships ativas.
 *
 * Posse = empresa gravada no fechamento (a mesma de `contratoDoTenant`/`versaoDoTenant`) E empresa do
 * pacote (a do Dashboard). Outra empresa, legado sem empresa e inexistente: o mesmo 404
 * (`ResumoTenantError`), sem distinguir.
 */

/** O fechamento é da empresa comprovada (fechamento e pacote)? */
export async function fechamentoPertenceAoTenant(tx: DbExecutor, empresaId: string, fechamentoId: string) {
  const r = await tx.query<{ id: string }>(
    `SELECT fech.id::text AS id
       FROM fechamentos fech
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $2::uuid
      WHERE fech.id = $1::uuid AND fech.empresa_id = $2::uuid`,
    [fechamentoId, empresaId],
  );
  return r.rows.length === 1;
}

/** O pagamento é de um contrato cujo fechamento/pacote é da empresa comprovada? */
export async function pagamentoPertenceAoTenant(tx: DbExecutor, empresaId: string, pagamentoId: string) {
  const r = await tx.query<{ id: string }>(
    `SELECT p.id::text AS id
       FROM pagamentos p
       JOIN contrato_versoes ver ON ver.id = p.contrato_versao_id
       JOIN contratos contrato ON contrato.id = ver.contrato_id
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id AND fech.empresa_id = $2::uuid
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $2::uuid
      WHERE p.id = $1::uuid`,
    [pagamentoId, empresaId],
  );
  return r.rows.length === 1;
}

export const contratoNoTenant: ProvaDePosse = contratoPertenceAoTenant;
export const fechamentoNoTenant: ProvaDePosse = fechamentoPertenceAoTenant;
export const pagamentoNoTenant: ProvaDePosse = pagamentoPertenceAoTenant;

export type LinhaPainelContrato = { id: string; fechamento_id: string; status: string; nome: string | null; data_evento: string | null; pacote: string | null; convidados: string | null };

/** Lista do painel de contratos já filtrada pela empresa comprovada (nunca lista global filtrada depois). */
export async function listarContratosDoTenant(tx: DbExecutor, empresaId: string, incluirCancelados: boolean) {
  return (await tx.query<LinhaPainelContrato>(
    `SELECT c.id,c.fechamento_id,CASE WHEN c.status<>'ASSINADO' AND e.estado='CANCELADA' THEN 'PREPARACAO_CANCELADA' ELSE c.status END AS status,
            v.snapshot->'contratante'->>'nomeCompleto' AS nome,v.snapshot->'evento'->>'data' AS data_evento,
            v.snapshot->'evento'->'pacote'->>'nome' AS pacote,v.snapshot->'evento'->>'convidados' AS convidados
       FROM contratos c
       JOIN fechamentos fech ON fech.id = c.fechamento_id AND fech.empresa_id = $2::uuid
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $2::uuid
       LEFT JOIN contrato_versoes v ON v.contrato_id=c.id AND v.numero_versao=c.versao_atual
       LEFT JOIN contrato_edicoes e ON e.contrato_versao_id=v.id
      WHERE ($1::boolean OR (c.status <> 'CANCELADO' AND (e.estado IS DISTINCT FROM 'CANCELADA' OR c.status='ASSINADO')))
      ORDER BY c.criado_em DESC`,
    [incluirCancelados, empresaId],
  )).rows;
}
