import type { DbExecutor } from '../db/contracts.ts';
import { exigirGestaoNoTenant, type TenantComprovado } from '../saas/provar-tenant.ts';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';
import { referenciaTransferencia } from './politica.ts';

export async function filaDevolucao(tx: DbExecutor, tenant: TenantComprovado) {
  exigirGestaoNoTenant(tenant, 'Somente a Gestão consulta a fila de devolução.');
  return (await tx.query<{
    fechamento_id: string; end_to_end_id: string; valor_centavos: string; devolver_desde: Date;
    motivo: string; situacao: string; responsavel: string | null;
  }>(`SELECT s.fechamento_id,s.end_to_end_id,s.valor_centavos,s.devolver_desde,
    CASE WHEN r.credito_revertido_em IS NOT NULL THEN 'CANCELAMENTO_FESTA_SEM_BAIXA'
         ELSE coalesce(r.motivo_sem_garantia::text,s.garantia) END AS motivo,s.dinheiro AS situacao,
    r.devolucao_assumida_por AS responsavel FROM pre_reserva_situacoes s
    JOIN pre_reserva_recebimentos r USING (empresa_id,end_to_end_id)
    WHERE s.empresa_id=$1 AND s.dinheiro IN ('A_DEVOLVER','EM_DEVOLUCAO')
    ORDER BY s.devolver_desde,s.end_to_end_id`, [tenant.empresaComprovada])).rows;
}

export async function assumirDevolucao(tx: DbExecutor, tenant: TenantComprovado, referencia: string) {
  exigirGestaoNoTenant(tenant, 'Somente a Gestão assume a devolução.');
  const r = await tx.query(`UPDATE pre_reserva_recebimentos r SET devolucao_assumida_por=$3,devolucao_assumida_em=clock_timestamp()
    WHERE empresa_id=$1 AND end_to_end_id=$2 AND (contrato_id IS NULL OR credito_revertido_em IS NOT NULL) AND devolucao_assumida_em IS NULL
      AND (garantia_ate IS NULL OR encerramento IS NOT NULL OR garantia_ate<=clock_timestamp())
    RETURNING end_to_end_id`, [tenant.empresaComprovada,referenciaTransferencia(referencia),tenant.usuarioId]);
  if (!r.rows.length) throw new PacoteAdminError('DEVOLUCAO_INDISPONIVEL','Atualize a fila e confira o responsável pela transferência.',409);
}

export async function confirmarDevolucao(tx: DbExecutor, tenant: TenantComprovado, original: string,
  baixa: { referencia: string; valorCentavos: number; devolvidoEm: string; extratoConferido: boolean }) {
  exigirGestaoNoTenant(tenant, 'Somente a Gestão confirma a devolução.');
  if (!baixa.extratoConferido || !baixa.referencia.trim() || !Number.isSafeInteger(baixa.valorCentavos) ||
      !Number.isFinite(Date.parse(baixa.devolvidoEm))) throw new PacoteAdminError('BAIXA_INVALIDA','Confira a saída integral no extrato.',400);
  const r = await tx.query(`UPDATE pre_reserva_recebimentos SET devolvido_em=$4,referencia_devolucao=$5
    WHERE empresa_id=$1 AND end_to_end_id=$2 AND devolucao_assumida_por=$3 AND valor_centavos=$6
      AND devolvido_em IS NULL AND $4::timestamptz BETWEEN devolucao_assumida_em AND clock_timestamp()
    RETURNING end_to_end_id`,[tenant.empresaComprovada,referenciaTransferencia(original),tenant.usuarioId,
      baixa.devolvidoEm,baixa.referencia.trim(),baixa.valorCentavos]);
  if (!r.rows.length) throw new PacoteAdminError('BAIXA_INDISPONIVEL','Confira a transferência, a data, o valor integral e o responsável.',409);
}
