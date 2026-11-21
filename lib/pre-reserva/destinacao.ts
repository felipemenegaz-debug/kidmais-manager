import type { DbExecutor } from '../db/contracts.ts';

export async function recebimentosInstalados(tx: DbExecutor) {
  const { rows } = await tx.query<{ instalada: boolean }>(
    "SELECT to_regclass('public.pre_reserva_recebimentos') IS NOT NULL AS instalada",
  );
  return rows[0]?.instalada === true;
}

/** A formalização já validou a agenda e as assinaturas e mantém suas travas até o commit. */
export async function destinarSinalFormalizado(tx: DbExecutor, contrato: string, versao: string) {
  if (!await recebimentosInstalados(tx)) return;
  const resultado = await tx.query<{ total: string | null; sinal: string; empresa: string; pedido: string }>(`
    SELECT v.snapshot #>> '{comercial,valorFinalContrato}' AS total, r.valor_centavos AS sinal,
           r.empresa_id AS empresa, r.fechamento_id AS pedido
    FROM contratos c JOIN contrato_versoes v ON v.contrato_id=c.id AND v.id=$2
    JOIN fechamentos f ON f.id=c.fechamento_id
    JOIN pre_reserva_recebimentos r ON r.empresa_id=f.empresa_id AND r.fechamento_id=f.id
    WHERE c.id=$1 AND c.status='ASSINADO' AND v.status='ASSINADA' AND r.sinal_garantido_centavos IS NOT NULL AND r.encerramento IS NULL
      AND r.devolucao_assumida_em IS NULL FOR UPDATE OF r`, [contrato,versao]);
  const movimento = resultado.rows[0];
  if (!movimento) return;
  const total = Math.round(Number(movimento.total) * 100);
  if (!movimento.total || !Number.isSafeInteger(total) || total <= 0) throw new Error('Valor final do contrato inválido.');
  const creditar = total >= Number(movimento.sinal);
  await tx.query(`UPDATE pre_reserva_recebimentos SET encerramento=$3, encerrado_em=clock_timestamp(), contrato_id=$4
    WHERE empresa_id=$1 AND fechamento_id=$2 AND sinal_garantido_centavos IS NOT NULL`,
    [movimento.empresa,movimento.pedido,creditar ? 'FORMALIZACAO' : 'FORMALIZACAO_SEM_CREDITO',creditar ? contrato : null]);
}

export async function encerrarGarantia(tx: DbExecutor, empresa: string, pedido: string, motivo: 'RECUSA' | 'DESISTENCIA') {
  if (!await recebimentosInstalados(tx)) return false;
  const r = await tx.query(`UPDATE pre_reserva_recebimentos SET encerramento=$3, encerrado_em=clock_timestamp()
    WHERE empresa_id=$1 AND fechamento_id=$2 AND sinal_garantido_centavos IS NOT NULL AND encerramento IS NULL
    RETURNING fechamento_id`, [empresa,pedido,motivo]);
  return r.rows.length > 0;
}

/** O cancelamento já bloqueou o contrato e o marcou CANCELADO na transação da Festa.
 * A abertura do plano também bloqueia e revalida o contrato antes de criar o plano e a baixa.
 */
export async function reverterCreditoSemBaixa(tx: DbExecutor, empresa: string, contrato: string) {
  if (!await recebimentosInstalados(tx)) return;
  await tx.query(`UPDATE pre_reserva_recebimentos r SET credito_revertido_em=c.cancelado_em
    FROM contratos c WHERE c.id=$2 AND c.status='CANCELADO' AND r.contrato_id=c.id
    AND r.empresa_id=$1 AND r.credito_revertido_em IS NULL
    AND NOT EXISTS (SELECT FROM pagamento_recebimentos baixa JOIN pagamentos p ON p.id=baixa.pagamento_id
      JOIN contrato_versoes v ON v.id=p.contrato_versao_id WHERE v.contrato_id=c.id
      AND baixa.chave_idempotencia='PRE_RESERVA:' || c.id::text)`, [empresa,contrato]);
}

export async function creditoDoContrato(tx: DbExecutor, contrato: string, empresa: string) {
  if (!await recebimentosInstalados(tx)) return;
  const { rows } = await tx.query<{ valor: number; referencia: string; recebido: Date }>(`
    SELECT valor_centavos::int AS valor, end_to_end_id AS referencia, confirmado_em AS recebido
    FROM pre_reserva_recebimentos WHERE empresa_id=$1 AND contrato_id=$2 AND encerramento='FORMALIZACAO' AND credito_revertido_em IS NULL`, [empresa,contrato]);
  return rows[0];
}
