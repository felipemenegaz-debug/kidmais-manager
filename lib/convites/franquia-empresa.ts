import type { DbExecutor } from '../db/contracts';

export async function franquiaDaEmpresa(tx: DbExecutor, empresaId: string) {
  const w = (await tx.query<{ limite: number; usado: number }>(`SELECT CASE WHEN w.ativo THEN w.limite_mensal ELSE 0 END limite,COALESCE(u.usado,0)::int usado
    FROM convite_carteiras w LEFT JOIN convite_consumos u ON u.empresa_id=w.empresa_id AND u.mes=date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date WHERE w.empresa_id=$1`, [empresaId])).rows[0];
  return { limite: w?.limite ?? 0, usado: w?.usado ?? 0 };
}
