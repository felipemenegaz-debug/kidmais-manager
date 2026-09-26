import pg from "pg";

const PERMITIDOS = new Set(["kidmais_pacotes_v1_descartavel", "kidmais_pacotes_v1_rollback"]);
const TRAVA_TESTE = 8742036;

/** Conecta só no cluster descartável e confirma o banco antes de qualquer outro SQL. */
export async function conectarDescartavel(opcoes?: { travar?: boolean; database?: string }) {
  const database = opcoes?.database ?? "kidmais_pacotes_v1_descartavel";
  if (!PERMITIDOS.has(database)) throw new Error("banco recusado");
  const client = new pg.Client({
    host: "127.0.0.1",
    port: 55498,
    user: "kidmais_descartavel",
    database,
  });
  await client.connect();
  const ident = await client.query<{ db: string; port: number }>(
    "SELECT current_database() AS db, inet_server_port() AS port",
  );
  const db = ident.rows[0]?.db;
  const port = Number(ident.rows[0]?.port);
  if (!PERMITIDOS.has(String(db)) || port !== 55498) {
    await client.end();
    throw new Error("destino recusado");
  }
  if (opcoes?.travar !== false) await client.query("SELECT pg_advisory_lock($1)", [TRAVA_TESTE]);
  await client.query("SET statement_timeout = '30s'");
  return client;
}

export async function encerrarDescartavel(client: pg.Client, travou = true) {
  try {
    await client.query("ROLLBACK");
  } catch {
    /* sem transação aberta */
  }
  if (travou) {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [TRAVA_TESTE]);
    } catch {
      /* a sessão encerra a trava */
    }
  }
  await client.end();
}

export function semTransacaoExplicita(sql: string) {
  return sql
    .split(/\r?\n/)
    .filter((line) => !/^\s*BEGIN;\s*$/i.test(line) && !/^\s*COMMIT;\s*$/i.test(line))
    .join("\n");
}
