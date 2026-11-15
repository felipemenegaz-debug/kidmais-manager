import type { DbExecutor } from '../db/contracts';

/**
 * 124 — A tabela do papel do cliente existe nesta base? O PostgreSQL resolve as tabelas de uma consulta antes de avaliar
 * qualquer filtro (até `aceite_metodo='PAPEL_CLIENTE'` num ramo OR), então código novo sobre schema anterior à 124 só pode
 * citar `contrato_assinaturas_papel` depois desta conferência. Sem a 124 o caminho anterior continua igual.
 */
export async function papelClienteInstalado(tx: DbExecutor): Promise<boolean> {
  return (await tx.query<{ ok: boolean }>("SELECT to_regclass('public.contrato_assinaturas_papel') IS NOT NULL AS ok")).rows[0]?.ok === true;
}
