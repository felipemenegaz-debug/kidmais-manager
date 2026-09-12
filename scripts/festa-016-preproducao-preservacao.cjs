/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { Client } = require("pg");
const {
  assinaturaEstruturaFesta016,
  estruturaFesta016Sql,
  tabelasFesta016,
} = require("../lib/festas/estrutura-016.ts");

const sha256 = (conteudo) => createHash("sha256").update(conteudo).digest("hex");

async function main() {
  assert.equal(
    process.env.KIDMAIS_AUTORIZAR_LEITURA_BANCO_REAL,
    "SIM",
    "Leitura não autorizada. Defina KIDMAIS_AUTORIZAR_LEITURA_BANCO_REAL=SIM somente após aprovação explícita.",
  );
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL não configurada.");

  const destino = new URL(process.env.DATABASE_URL);
  assert.equal(
    destino.pathname,
    "/kidmais_manager",
    "A consulta protegida aceita somente o banco real kidmais_manager.",
  );

  const migration = "database/migrations/20260911_016_festa.sql";
  assert.equal(
    sha256(fs.readFileSync(migration)),
    "3843802812f7a970f8824f3836eef592bf3b565d1721a4ed33c75e5b620774a2",
    "O arquivo canônico da Migration 016 foi alterado.",
  );

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    options: "-c default_transaction_read_only=on -c statement_timeout=15000",
    ssl: process.env.DATABASE_SSL === "true"
      ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" }
      : undefined,
    connectionTimeoutMillis: 5_000,
  });

  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const banco = (await client.query("SELECT current_database() AS nome")).rows[0]?.nome;
    assert.equal(banco, "kidmais_manager");

    const resultado = await client.query(estruturaFesta016Sql, [tabelasFesta016]);
    assert.equal(
      resultado.rows[0]?.assinatura,
      assinaturaEstruturaFesta016,
      "A estrutura física do módulo Festa não corresponde à 016 homologada.",
    );

    await client.query("ROLLBACK");
    console.log(
      "PASS banco real somente leitura: Migration 016 e estrutura Festa correspondem à assinatura homologada; nenhuma linha foi alterada.",
    );
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // A conexão pode ter sido encerrada; não há escrita a desfazer.
    }
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Falha na verificação.");
  process.exitCode = 1;
});
