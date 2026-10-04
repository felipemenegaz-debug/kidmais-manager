import pg from "pg";
import { alvoAutorizado054, conferirIdentidade054, type Alvo054 } from "./alvo-054.ts";
import { senhaRecusada } from "../comercial/alvo-descartavel.ts";

/** Mesma trava consultiva da suíte descartável: os arquivos PostgreSQL rodam um de cada vez. */
const TRAVA_SUITE = 8742036;

/**
 * Conexão do ciclo da 054. Valida o alvo antes de conectar e a identidade do servidor antes de
 * qualquer outro SQL; a primeira falha encerra a conexão. Nunca lê DATABASE_URL nem `.env*`.
 */
export async function conectar054(opcoes?: { travar?: boolean }) {
  const alvo: Alvo054 = alvoAutorizado054(process.env);
  const client = new pg.Client({
    host: alvo.host,
    port: alvo.port,
    database: alvo.database,
    user: alvo.user,
    password: senhaRecusada,
    application_name: "kidmais-054-descartavel",
  });
  await client.connect();
  try {
    const r = await client.query<{ db: string | null; addr: string | null; port: number | null }>(
      "SELECT current_database() AS db, host(inet_server_addr()) AS addr, inet_server_port() AS port",
    );
    conferirIdentidade054(alvo, { database: r.rows[0]?.db ?? null, addr: r.rows[0]?.addr ?? null, port: r.rows[0]?.port == null ? null : Number(r.rows[0].port) });
  } catch (erro) {
    await client.end();
    throw erro;
  }
  if (opcoes?.travar !== false) await client.query("SELECT pg_advisory_lock($1)", [TRAVA_SUITE]);
  await client.query("SET statement_timeout = '60s'");
  return client;
}

export async function encerrar054(client: pg.Client, travou = true) {
  try {
    await client.query("ROLLBACK");
  } catch {
    /* sem transação aberta */
  }
  if (travou) {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [TRAVA_SUITE]);
    } catch {
      /* a sessão encerra a trava */
    }
  }
  await client.end();
}

/** Remove só as linhas exatas `BEGIN;`/`COMMIT;` do arquivo (execução dentro da transação do teste). */
export function semTransacaoExplicita054(sql: string) {
  return sql
    .split(/\r?\n/)
    .filter((linha) => !/^\s*BEGIN;\s*$/i.test(linha) && !/^\s*COMMIT;\s*$/i.test(linha))
    .join("\n");
}
