import { z } from 'zod';
import type { DbExecutor } from '../db/contracts.ts';
import { exigirGestaoNoTenant, type TenantComprovado } from '../saas/provar-tenant.ts';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';
import { POLITICA_PRE_RESERVA, referenciaTransferencia } from './politica.ts';
import { auditarMovimentoPreReserva } from './auditoria.ts';
import { recebimentosInstalados } from './destinacao.ts';

const instanteComOffset = z.union([
  z.iso.datetime({ offset: true }),
  z.iso.datetime({ offset: true, precision: -1 }),
]).refine(valor => valor.endsWith('Z') || Number(valor.slice(-5, -3)) < 16);
type Movimento = { fechamento_id: string; instante: string };

async function exigirRecebimentos(tx: DbExecutor) {
  if (!await recebimentosInstalados(tx)) {
    throw new PacoteAdminError('PRE_RESERVA_INDISPONIVEL', 'A operação de devolução ainda não está disponível.', 503);
  }
}

export async function filaDevolucao(tx: DbExecutor, tenant: TenantComprovado) {
  exigirGestaoNoTenant(tenant, 'Somente a Gestão consulta a fila de devolução.');
  const { rows: [schema] } = await tx.query<{ instalada: boolean }>(
    "SELECT to_regprocedure('public.pre_reserva_exigir_configuracao()') IS NOT NULL AS instalada",
  );
  if (!schema.instalada) {
    throw new PacoteAdminError('PRE_RESERVA_INDISPONIVEL', 'A fila de devolução ainda não está disponível.', 503);
  }
  const { rows } = await tx.query<{
    fechamento_id: string; end_to_end_id: string; valor_centavos: string; devolver_desde: Date;
    motivo: string; situacao: string; responsavel: string | null; devolucao_assumida_em: Date | null;
  }>(`SELECT s.fechamento_id,s.end_to_end_id,s.valor_centavos,s.devolver_desde,
    coalesce(s.credito_reversao_motivo,r.motivo_sem_garantia::text,s.garantia) AS motivo,s.dinheiro AS situacao,
    r.devolucao_assumida_por AS responsavel,r.devolucao_assumida_em FROM pre_reserva_situacoes s
    JOIN pre_reserva_recebimentos r USING (empresa_id,end_to_end_id)
    WHERE s.empresa_id=$1 AND s.dinheiro IN ('A_DEVOLVER','EM_DEVOLUCAO')
    ORDER BY s.devolver_desde,s.end_to_end_id`, [tenant.empresaComprovada]);
  return rows.map(movimento => ({ ...movimento, prazo: POLITICA_PRE_RESERVA.prazoDevolucao }));
}

export async function assumirDevolucao(tx: DbExecutor, tenant: TenantComprovado, referencia: string) {
  exigirGestaoNoTenant(tenant, 'Somente a Gestão assume a devolução.');
  await exigirRecebimentos(tx);
  const parametros = [tenant.empresaComprovada, referenciaTransferencia(referencia), tenant.usuarioId];
  const { rows: [movimento] } = await tx.query<Movimento>(`UPDATE pre_reserva_recebimentos
    SET devolucao_assumida_por=$3,devolucao_assumida_em=clock_timestamp()
    WHERE empresa_id=$1 AND end_to_end_id=$2 AND (contrato_id IS NULL OR credito_revertido_em IS NOT NULL) AND devolucao_assumida_em IS NULL
      AND (garantia_ate IS NULL OR encerramento IS NOT NULL OR garantia_ate<=clock_timestamp())
    RETURNING fechamento_id,devolucao_assumida_em::text AS instante`, parametros);
  if (movimento) {
    await auditarMovimentoPreReserva(tx, tenant, 'PRE_RESERVA_DEVOLUCAO_ASSUMIDA',
      tenant.empresaComprovada, movimento.fechamento_id, parametros[1], movimento.instante);
    return;
  }
  const repeticao = await tx.query(`SELECT 1 FROM pre_reserva_recebimentos
    WHERE empresa_id=$1 AND end_to_end_id=$2 AND devolucao_assumida_por=$3`, parametros);
  if (!repeticao.rows.length) throw new PacoteAdminError('DEVOLUCAO_INDISPONIVEL','Atualize a fila e confira o responsável pela transferência.',409);
}

export async function confirmarDevolucao(tx: DbExecutor, tenant: TenantComprovado, original: string,
  baixa: { referencia: string; valorCentavos: number; devolvidoEm: string; extratoConferido: boolean }) {
  exigirGestaoNoTenant(tenant, 'Somente a Gestão confirma a devolução.');
  if (!baixa.extratoConferido || !baixa.referencia.trim() || !Number.isSafeInteger(baixa.valorCentavos) || baixa.valorCentavos <= 0 ||
      !instanteComOffset.safeParse(baixa.devolvidoEm).success) {
    throw new PacoteAdminError('BAIXA_INVALIDA','Confira a saída integral e informe a data com hora e offset.',400);
  }
  await exigirRecebimentos(tx);
  const referencia = referenciaTransferencia(original);
  const parametros = [tenant.empresaComprovada, referencia, tenant.usuarioId,
    baixa.devolvidoEm, baixa.referencia.trim(), baixa.valorCentavos];
  const { rows: [movimento] } = await tx.query<Movimento>(`UPDATE pre_reserva_recebimentos
    SET devolvido_por=$3,devolvido_em=$4,referencia_devolucao=$5
    WHERE empresa_id=$1 AND end_to_end_id=$2 AND devolucao_assumida_em IS NOT NULL AND valor_centavos=$6
      AND devolvido_em IS NULL AND $4::timestamptz BETWEEN devolucao_assumida_em AND clock_timestamp()
    RETURNING fechamento_id,devolvido_em::text AS instante`, parametros);
  if (movimento) {
    await auditarMovimentoPreReserva(tx, tenant, 'PRE_RESERVA_DEVOLUCAO_CONFIRMADA',
      tenant.empresaComprovada, movimento.fechamento_id, referencia, movimento.instante);
    return;
  }
  const repeticao = await tx.query(`SELECT 1 FROM pre_reserva_recebimentos
    WHERE empresa_id=$1 AND end_to_end_id=$2 AND devolvido_por=$3 AND devolvido_em=$4
      AND referencia_devolucao=$5 AND valor_centavos=$6`, parametros);
  if (!repeticao.rows.length) throw new PacoteAdminError('BAIXA_INDISPONIVEL','Confira a assunção, a data e o valor integral da transferência.',409);
}
