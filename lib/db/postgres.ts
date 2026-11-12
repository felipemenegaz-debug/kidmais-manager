import { Pool, type PoolClient } from "pg";
import type { DbExecutor, DbQueryResult } from "./contracts";
import { conexaoDescartavelDoPoolPg, type ConexaoDescartavel } from "./transacao-com-prazo.ts";

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

  return new Pool({ connectionString, ssl: sslConfig(), ...opcoesDaConexaoWeb(process.env) });
}

/**
 * B-14 (plano rev. 8.1, §5): o web se identifica em `pg_stat_activity`, para que a prova de drenagem distinga as sessões
 * do web das ferramentas e crons (que já definem o próprio `application_name`).
 */
export const NOME_APLICACAO_WEB = "kidmais-web";
export function opcoesDaConexaoWeb(env: Record<string, string | undefined>) {
  return { application_name: NOME_APLICACAO_WEB, ...opcoesDoPool(env) };
}

/**
 * Tamanho do pool (docs/LOGIN_LIMITE_ORIGEM_POOL_20261022.md). O Postgres do Render no plano 0.1c-256mb aceita
 * cerca de 100 conexões (algumas reservadas ao superusuário). No deploy sem interrupção, a instância antiga e a nova
 * coexistem: 2 × 30 = 60, e sobram ~35 para os crons (3 cada), migrations, psql e o monitoramento do Render.
 * Mais conexões não trazem CPU: com a CPU saturada, a espera só muda de lugar (do pool para o processador).
 * Valor inválido no ambiente cai no padrão, e o máximo nunca passa do teto seguro.
 */
export const POOL_PADRAO = { max: 30, teto: 40, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 } as const;
export function opcoesDoPool(env: Record<string, string | undefined>) {
  const inteiro = (valor: string | undefined, padrao: number) => (valor && /^[1-9]\d{0,8}$/.test(valor) ? Number(valor) : padrao);
  return {
    max: Math.min(inteiro(env.DATABASE_POOL_MAX, POOL_PADRAO.max), POOL_PADRAO.teto),
    idleTimeoutMillis: inteiro(env.DATABASE_IDLE_TIMEOUT_MS, POOL_PADRAO.idleTimeoutMillis),
    connectionTimeoutMillis: inteiro(env.DATABASE_CONNECTION_TIMEOUT_MS, POOL_PADRAO.connectionTimeoutMillis),
  };
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

/**
 * Conexão do pool para uma transação com prazo do lado da aplicação (lib/db/transacao-com-prazo.ts): no prazo vencido,
 * é descartada (soquete destruído, removida do pool) em vez de voltar ao pool com estado incerto.
 */
export async function conexaoDescartavelDoPool(registrar?: (conexao: ConexaoDescartavel) => void): Promise<ConexaoDescartavel> {
  return conexaoDescartavelDoPoolPg(getPool() as unknown as Parameters<typeof conexaoDescartavelDoPoolPg>[0], registrar);
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
