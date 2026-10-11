import type { DbExecutor } from "../db/contracts.ts";

/**
 * A 078 (catálogo do buffet por empresa) está aplicada neste banco? Antes dela o catálogo é global e o código mantém o
 * comportamento anterior: leituras pelo pacote da empresa e NENHUMA escrita no catálogo (CATALOGO_GLOBAL_SEM_AUTORIDADE).
 * Depois dela, toda leitura e escrita filtram por empresa_id.
 */
export async function catalogoBuffetPorEmpresa(tx: DbExecutor): Promise<boolean> {
  const r = await tx.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'buffet_categorias' AND column_name = 'empresa_id') AS ok`,
  );
  return r.rows[0]?.ok === true;
}
