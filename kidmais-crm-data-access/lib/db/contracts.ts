export type DbPrimitive = string | number | boolean | Date | null | undefined;

export interface DbQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

/**
 * Contrato mínimo usado pelos repositories.
 * Mantém a camada de domínio desacoplada do driver PostgreSQL.
 */
export interface DbExecutor {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<DbQueryResult<Row>>;
}
