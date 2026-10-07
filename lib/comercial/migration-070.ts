import type { DbExecutor } from "../db/contracts.ts";

/** A 070 traz a origem do adicional no buffet. Antes dela as telas leem sem origem e a gravação é recusada. */
export async function migration070Aplicada(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = current_schema() AND table_name = 'adicionais'
                       AND column_name = 'origem_buffet_categoria_id') AS ok`,
  );
  return Boolean(r.rows[0]?.ok);
}
