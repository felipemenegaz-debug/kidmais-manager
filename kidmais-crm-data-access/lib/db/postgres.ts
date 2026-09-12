import { Pool, type PoolClient } from "pg";
import type { DbExecutor, DbQueryResult } from "./contracts";

type GlobalComPool = typeof globalThis & {
  __kidmaisPgPool?: Pool;
};

function sslConfig() {
  if (process.env.DATABASE_SSL !== "true") return undefined;

  return {
    rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false",
  };
}

function criarPool() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL não configurada. Defina a conexão PostgreSQL antes de acessar o banco.",
    );
  }

  return new Pool({
    connectionString,
    ssl: sslConfig(),
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS ?? 30_000),
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? 5_000),
  });
}

function getPool(): Pool {
  const globalRef = globalThis as GlobalComPool;

  if (process.env.NODE_ENV === "production") {
    return globalRef.__kidmaisPgPool ?? (globalRef.__kidmaisPgPool = criarPool());
  }

  // Em desenvolvimento, preserva o pool entre hot reloads do Next.js.
  return globalRef.__kidmaisPgPool ?? (globalRef.__kidmaisPgPool = criarPool());
}

function executorFrom(client: Pool | PoolClient): DbExecutor {
  return {
    async query<Row extends object>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<DbQueryResult<Row>> {
      const result = await client.query(text, [...values]);
      return {
        rows: result.rows as Row[],
        rowCount: result.rowCount,
      };
    },
  };
}

export function db(): DbExecutor {
  return executorFrom(getPool());
}

export async function withTransaction<T>(
  work: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const result = await work(executorFrom(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function databaseHealthCheck() {
  const result = await db().query<{ ok: number }>("SELECT 1 AS ok");
  return result.rows[0]?.ok === 1;
}

export async function closeDatabasePool() {
  const globalRef = globalThis as GlobalComPool;
  const pool = globalRef.__kidmaisPgPool;
  if (!pool) return;
  await pool.end();
  delete globalRef.__kidmaisPgPool;
}
