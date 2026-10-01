import pg from "pg";
import { recusarMarcaKidmais, provisionarTenant } from "../lib/saas/provisionar-tenant.ts";
import type { DbExecutor } from "../lib/db/contracts.ts";

const database = "kidmais_pacotes_v1_descartavel";
const port = 55498;

function argumento(nome: string) {
  const indice = process.argv.indexOf(nome);
  const valor = indice >= 0 ? process.argv[indice + 1] : "";
  if (!valor || valor.startsWith("--")) {
    throw new Error(`argumento ausente: ${nome}`);
  }
  return valor;
}

async function main() {
  const codigo = argumento("--codigo");
  const nome = argumento("--nome");
  const usuarioId = argumento("--usuario");
  recusarMarcaKidmais(codigo, nome);
  const client = new pg.Client({
    host: "127.0.0.1",
    port,
    user: "kidmais_descartavel",
    database,
  });
  await client.connect();
  try {
    const ident = await client.query<{ db: string; port: number }>(
      "SELECT current_database() AS db, inet_server_port() AS port",
    );
    if (ident.rows[0]?.db !== database || Number(ident.rows[0]?.port) !== port) {
      throw new Error("destino recusado");
    }
    const tx: DbExecutor = {
      async query(text, values = []) {
        const result = await client.query(text, [...values]);
        return { rows: result.rows, rowCount: result.rowCount };
      },
    };
    await client.query("BEGIN");
    const tenant = await provisionarTenant(tx, {
      codigo,
      nome,
      usuarioId,
      atorUsuarioId: usuarioId,
    });
    await client.query("COMMIT");
    process.stdout.write(`${tenant.empresaComprovada}\n`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "falha";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
