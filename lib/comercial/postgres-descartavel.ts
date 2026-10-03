import pg from "pg";
import { exigirAmbienteSemConexaoHerdada, portaDescartavel, senhaRecusada } from "./alvo-descartavel.ts";

const PERMITIDOS = new Set(["kidmais_pacotes_v1_descartavel", "kidmais_pacotes_v1_rollback"]);
const TRAVA_TESTE = 8742036;
// Guarda da porta num módulo puro (testável sem driver); reexportada para as suítes.
export { portaDescartavel, senhaRecusada } from "./alvo-descartavel.ts";

/** Conecta só no cluster descartável e confirma o banco antes de qualquer outro SQL. */
export async function conectarDescartavel(opcoes?: { travar?: boolean; database?: string }) {
  const database = opcoes?.database ?? "kidmais_pacotes_v1_descartavel";
  if (!PERMITIDOS.has(database)) throw new Error("banco recusado");
  exigirAmbienteSemConexaoHerdada();
  const portaAutorizada = portaDescartavel();
  // Tudo explícito; nenhuma senha é carregada (pgpass/PGPASSWORD) e nenhuma variável PG* participa.
  const client = new pg.Client({
    host: "127.0.0.1",
    port: portaAutorizada,
    user: "kidmais_descartavel",
    database,
    password: senhaRecusada,
    application_name: "kidmais-descartavel",
  });
  await client.connect();
  const ident = await client.query<{ db: string; port: number }>(
    "SELECT current_database() AS db, inet_server_port() AS port",
  );
  const db = ident.rows[0]?.db;
  const port = Number(ident.rows[0]?.port);
  if (!PERMITIDOS.has(String(db)) || port !== portaAutorizada) {
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

/**
 * D3 — linha de base do estado canônico ATUAL (receita scripts/regressao-v1-postgres-receita.cjs, 001→054):
 * a 046 atribuiu os sete pacotes oficiais à empresa Kidmais; não há pacote legado sem empresa. Suítes de
 * produto conferem que começam nela e que a deixam intacta (nenhuma suíte cria outra "Kidmais" nem toca o legado).
 */
export const SETE_PACOTES_OFICIAIS = ["COMPACTA", "COMPLETA", "ESSENCIAL", "MINI_FESTA", "PIZZA_PARTY", "POCKET", "PREMIUM"];
export const LINHA_DE_BASE_ATUAL = { legado: 0, kidmais: 1, oficiaisDaKidmais: 7 } as const;

export async function linhaDeBase(client: { query: pg.Client["query"] }) {
  const r = await (client as pg.Client).query<{ legado: number; kidmais: number; oficiaisDaKidmais: number }>(
    `SELECT
       (SELECT count(*)::int FROM pacotes WHERE empresa_id IS NULL) AS legado,
       (SELECT count(*)::int FROM empresas WHERE codigo ILIKE '%kidmais%' OR nome ILIKE '%kidmais%') AS kidmais,
       (SELECT count(*)::int FROM pacotes p JOIN empresas e ON e.id = p.empresa_id
         WHERE e.codigo = 'kidmais' AND e.status = 'ATIVA' AND p.codigo = ANY($1::text[])) AS "oficiaisDaKidmais"`,
    [SETE_PACOTES_OFICIAIS],
  );
  return { ...r.rows[0] };
}

export function semTransacaoExplicita(sql: string) {
  return sql
    .split(/\r?\n/)
    .filter((line) => !/^\s*BEGIN;\s*$/i.test(line) && !/^\s*COMMIT;\s*$/i.test(line))
    .join("\n");
}
