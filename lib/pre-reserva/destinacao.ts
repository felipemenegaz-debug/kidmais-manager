import type { DbExecutor } from '../db/contracts.ts';
import { auditarMovimentoPreReserva } from './auditoria.ts';

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

export async function encerrarGarantia(tx: DbExecutor, empresa: string, pedido: string, motivo: 'RECUSA' | 'DESISTENCIA', somenteAtiva = false) {
  if (!await recebimentosInstalados(tx)) return null;
  const r = await tx.query<{ encerradoEm: string }>(`UPDATE pre_reserva_recebimentos SET encerramento=$3, encerrado_em=clock_timestamp()
    WHERE empresa_id=$1 AND fechamento_id=$2 AND sinal_garantido_centavos IS NOT NULL AND encerramento IS NULL
      AND (NOT $4::boolean OR garantia_ate > clock_timestamp())
    RETURNING to_char(encerrado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "encerradoEm"`,
    [empresa,pedido,motivo,somenteAtiva]);
  return r.rows[0]?.encerradoEm ?? null;
}

const semBaixaNoPlano = `NOT EXISTS (SELECT FROM pagamento_recebimentos baixa
  JOIN pagamentos p ON p.id=baixa.pagamento_id JOIN contrato_versoes v ON v.id=p.contrato_versao_id
  WHERE v.contrato_id=r.contrato_id AND baixa.chave_idempotencia='PRE_RESERVA:' || r.contrato_id::text)`;

type Reversao = { empresa_id: string; fechamento_id: string; end_to_end_id: string; instante: string };
const movimentoRevertido = 'r.empresa_id, r.fechamento_id, r.end_to_end_id, r.credito_revertido_em::text AS instante';

/** O cancelamento já bloqueou o contrato e o marcou CANCELADO na transação da Festa. */
export async function reverterCreditoSemBaixa(tx: DbExecutor, empresa: string, contrato: string, usuarioId: string) {
  if (!await recebimentosInstalados(tx)) return;
  const motivo = 'CANCELAMENTO_FESTA_SEM_BAIXA';
  const { rows: [movimento] } = await tx.query<Reversao>(`UPDATE pre_reserva_recebimentos r
    SET credito_revertido_em=c.cancelado_em, credito_reversao_motivo=$3
    FROM contratos c WHERE c.id=$2 AND c.status='CANCELADO' AND r.contrato_id=c.id
    AND r.empresa_id=$1 AND r.credito_revertido_em IS NULL AND ${semBaixaNoPlano}
    RETURNING ${movimentoRevertido}`, [empresa,contrato,motivo]);
  if (movimento) await auditarMovimentoPreReserva(tx, { usuarioId }, 'PRE_RESERVA_CREDITO_REVERTIDO',
    movimento.empresa_id, movimento.fechamento_id, movimento.end_to_end_id, movimento.instante, { motivo, contratoId: contrato });
}

/** A promoção e a abertura do plano mantêm o mesmo contrato travado até o commit. */
export async function reverterCreditoPorAditivo(tx: DbExecutor, contrato: string, versao: string,
  ator: { usuarioId: string } | { clienteId: string },
) {
  if (!await recebimentosInstalados(tx)) return;
  const { rows: [credito] } = await tx.query<{ empresa_id: string; end_to_end_id: string; abaixo: boolean | null }>(`
    SELECT r.empresa_id, r.end_to_end_id,
      CASE WHEN total BETWEEN 0 AND 9999999999.99 AND total=trunc(total,2) THEN total*100<r.valor_centavos END AS abaixo
    FROM pre_reserva_recebimentos r
    JOIN contrato_fluxos f ON f.contrato_id=r.contrato_id AND f.versao_vigente_id=$2
    JOIN contrato_versoes v ON v.id=f.versao_vigente_id AND v.contrato_id=f.contrato_id
    CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(v.snapshot #> '{comercial,valorFinalContrato}')='number'
      THEN (v.snapshot #>> '{comercial,valorFinalContrato}')::numeric END AS total) snapshot
    WHERE r.contrato_id=$1 AND r.credito_revertido_em IS NULL AND ${semBaixaNoPlano}`, [contrato,versao]);
  if (!credito) return;
  if (credito.abaixo === null) throw new Error('Valor final ausente ou inválido no snapshot do aditivo vigente');
  if (!credito.abaixo) return;
  const motivo = 'ADITIVO_ABAIXO_DO_CREDITO';
  const { rows: [movimento] } = await tx.query<Reversao>(`UPDATE pre_reserva_recebimentos r
    SET credito_revertido_em=clock_timestamp(), credito_reversao_motivo=$3
    WHERE r.empresa_id=$1 AND r.end_to_end_id=$2 AND r.credito_revertido_em IS NULL
    RETURNING ${movimentoRevertido}`, [credito.empresa_id,credito.end_to_end_id,motivo]);
  if (movimento) await auditarMovimentoPreReserva(tx, ator, 'PRE_RESERVA_CREDITO_REVERTIDO',
    movimento.empresa_id, movimento.fechamento_id, movimento.end_to_end_id, movimento.instante,
    { motivo, contratoId: contrato, versaoId: versao });
}

export async function creditoDoContrato(tx: DbExecutor, contrato: string, empresa: string) {
  if (!await recebimentosInstalados(tx)) return;
  const { rows } = await tx.query<{ valor: number; referencia: string; recebido: Date }>(`
    SELECT valor_centavos::int AS valor, end_to_end_id AS referencia, confirmado_em AS recebido
    FROM pre_reserva_recebimentos WHERE empresa_id=$1 AND contrato_id=$2 AND encerramento='FORMALIZACAO' AND credito_revertido_em IS NULL`, [empresa,contrato]);
  return rows[0];
}
