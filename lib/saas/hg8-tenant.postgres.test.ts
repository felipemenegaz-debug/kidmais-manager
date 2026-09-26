import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { listarPacotesAdmin } from "../comercial/pacotes-admin.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { executarNoTenant, provarTenant } from "./provar-tenant.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function texto(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function codigo() {
  return `hg8p${randomBytes(4).toString("hex")}`;
}

function senhaFalsa() {
  return `scrypt$v=1$N=131072$r=8$p=1$${ "A".repeat(22) }==$${ "B".repeat(86) }==`;
}

function executor(client: Client): DbExecutor {
  return {
    async query<Row extends object>(text: string, values: readonly unknown[] = []) {
      const result = await client.query(text, [...values]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
  };
}

async function empresa(client: Client, nome = "Empresa provada") {
  const id = (await client.query<{ id: string }>(
    `INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`,
    [codigo(), nome],
  )).rows[0].id;
  await client.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [id]);
  return id;
}

async function usuario(client: Client, ativo = true) {
  return (await client.query<{ id: string }>(
    `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo)
     VALUES ($1, 'Operador', $2, 'REPRESENTANTE_AUTORIZADO', $3) RETURNING id`,
    [`${codigo()}@example.test`, senhaFalsa(), ativo],
  )).rows[0].id;
}

async function membership(client: Client, empresaId: string, usuarioId: string, status: "PENDENTE" | "ATIVA" | "REVOGADA") {
  const id = (await client.query<{ id: string }>(
    `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde)
     VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp()) RETURNING id`,
    [empresaId, usuarioId],
  )).rows[0].id;
  if (status === "ATIVA" || status === "REVOGADA") {
    await client.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [id]);
  }
  if (status === "REVOGADA") {
    await client.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [id]);
  }
  return id;
}

function sessao(usuarioId: string) {
  return { usuario_id: usuarioId, papel: "REPRESENTANTE_AUTORIZADO" };
}

async function recusaProva(client: Client, usuarioId: string, empresaId?: string) {
  await client.query("SAVEPOINT prova");
  let code = "";
  try {
    await provarTenant(executor(client), sessao(usuarioId), empresaId);
    code = "passou";
  } catch (error) {
    code = error instanceof PacoteAdminError ? error.code : texto(error);
  }
  await client.query("ROLLBACK TO SAVEPOINT prova");
  assert.equal(code, "TENANT_NAO_COMPROVADO");
}

function rastrear(trabalho: Promise<string>) {
  let terminou = false;
  const promessa = trabalho.finally(() => {
    terminou = true;
  });
  return {
    promessa,
    async aindaEspera() {
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.equal(terminou, false, "a revogação não ficou bloqueada");
    },
  };
}

async function limpar(client: Client) {
  await client.query("ALTER TABLE memberships DISABLE TRIGGER USER");
  await client.query("ALTER TABLE empresas DISABLE TRIGGER USER");
  try {
    await client.query(
      `DELETE FROM pacotes WHERE empresa_id IN (SELECT id FROM empresas WHERE codigo LIKE 'hg8p%')`,
    );
    await client.query(
      `DELETE FROM memberships
        WHERE empresa_id IN (SELECT id FROM empresas WHERE codigo LIKE 'hg8p%')
           OR usuario_id IN (SELECT id FROM usuarios_administrativos WHERE email LIKE 'hg8p%@example.test')`,
    );
    await client.query("DELETE FROM empresas WHERE codigo LIKE 'hg8p%'");
    await client.query("DELETE FROM usuarios_administrativos WHERE email LIKE 'hg8p%@example.test'");
  } finally {
    await client.query("ALTER TABLE empresas ENABLE TRIGGER USER");
    await client.query("ALTER TABLE memberships ENABLE TRIGGER USER");
  }
}

test("prova de tenant no postgres descartável", { timeout: 120_000 }, async (t) => {
  assert.equal(readFileSync(resolve(root, "lib/autenticacao/service.ts"), "utf8").includes("empresaComprovada"), false);
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  const tx = executor(db);
  try {
    const ident = await db.query<{ db: string; port: number }>(
      "SELECT current_database() AS db, inet_server_port() AS port",
    );
    assert.equal(ident.rows[0].db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.rows[0].port), 55498);

    await t.test("só membership ativa em empresa ativa prova, e o id do cliente só escolhe", async () => {
      await db.query("BEGIN");
      try {
        const empresaA = await empresa(db, "Empresa A");
        const empresaB = await empresa(db, "Empresa B");
        const usuarioA = await usuario(db);
        const semVinculo = await usuario(db);
        const dois = await usuario(db);
        await membership(db, empresaA, usuarioA, "ATIVA");
        await membership(db, empresaA, dois, "ATIVA");
        await membership(db, empresaB, dois, "ATIVA");
        const provada = await provarTenant(tx, sessao(usuarioA));
        assert.equal(provada.empresaComprovada, empresaA);
        assert.equal((await provarTenant(tx, sessao(usuarioA), empresaA)).empresaComprovada, empresaA);
        await recusaProva(db, usuarioA, empresaB);
        await recusaProva(db, usuarioA, randomUUID());
        await recusaProva(db, semVinculo);
        await recusaProva(db, dois);
        assert.equal((await provarTenant(tx, sessao(dois), empresaB)).empresaComprovada, empresaB);

        const pendente = await usuario(db);
        await membership(db, empresaA, pendente, "PENDENTE");
        await recusaProva(db, pendente, empresaA);
        const revogado = await usuario(db);
        await membership(db, empresaA, revogado, "REVOGADA");
        await recusaProva(db, revogado, empresaA);
        const inativo = await usuario(db, false);
        await membership(db, empresaA, inativo, "ATIVA");
        await recusaProva(db, inativo, empresaA);

        await db.query(`UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1::uuid`, [empresaB]);
        await recusaProva(db, dois, empresaB);
        await db.query(`UPDATE empresas SET status = 'DESATIVADA' WHERE id = $1::uuid`, [empresaB]);
        await recusaProva(db, dois, empresaB);

        await db.query(
          `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente)
           VALUES ($1::uuid, $2, 'Pacote da empresa', 900, true, true)`,
          [empresaA, `HG8P_${randomBytes(3).toString("hex").toUpperCase()}`],
        );
        const lista = await listarPacotesAdmin(tx, provada.empresaComprovada);
        const legado = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pacotes WHERE empresa_id IS NULL AND codigo = ANY($1::text[])`,
          [lista.map((item) => item.codigo)],
        );
        assert.equal(legado.rows[0].n, 0);
        assert.equal(lista.every((item) => item.empresaId === empresaA), true);
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("a operação não confirma depois de uma revogação já confirmada", async () => {
      await db.query("BEGIN");
      const empresaId = await empresa(db);
      const usuarioId = await usuario(db);
      const membershipId = await membership(db, empresaId, usuarioId, "ATIVA");
      await db.query("COMMIT");
      const outro = await conectarDescartavel({ travar: false });
      try {
        await outro.query("BEGIN");
        await outro.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [membershipId]);
        await outro.query("COMMIT");
        await db.query("BEGIN");
        let code = "";
        try {
          await executarNoTenant(tx, sessao(usuarioId), empresaId, async (transacao) => {
            await transacao.query(`UPDATE empresas SET nome = 'nao-deve-gravar' WHERE id = $1::uuid`, [empresaId]);
          });
          code = "passou";
        } catch (error) {
          code = error instanceof PacoteAdminError ? error.code : texto(error);
        }
        await db.query("ROLLBACK");
        assert.equal(code, "TENANT_NAO_COMPROVADO");
        const nome = await db.query<{ nome: string }>("SELECT nome FROM empresas WHERE id = $1::uuid", [empresaId]);
        assert.equal(nome.rows[0].nome, "Empresa provada");
      } finally {
        await outro.query("ROLLBACK").catch(() => undefined);
        await outro.end();
      }
    });

    await t.test("a revogação espera a operação que já travou a membership", async () => {
      await db.query("BEGIN");
      const empresaId = await empresa(db, "Empresa da corrida");
      const usuarioId = await usuario(db);
      const membershipId = await membership(db, empresaId, usuarioId, "ATIVA");
      await db.query("COMMIT");
      const titular = await conectarDescartavel({ travar: false });
      const outro = await conectarDescartavel({ travar: false });
      try {
        await titular.query("BEGIN");
        await executarNoTenant(executor(titular), sessao(usuarioId), null, async (transacao) => {
          await transacao.query(`UPDATE empresas SET nome = 'operacao-d10' WHERE id = $1::uuid`, [empresaId]);
        });
        const corrida = rastrear((async () => {
          await outro.query("BEGIN");
          await outro.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [membershipId]);
          await outro.query("COMMIT");
          return "ok";
        })());
        await corrida.aindaEspera();
        await titular.query("COMMIT");
        assert.equal(await corrida.promessa, "ok");
        const nome = await db.query<{ nome: string }>("SELECT nome FROM empresas WHERE id = $1::uuid", [empresaId]);
        assert.equal(nome.rows[0].nome, "operacao-d10");
        await db.query("BEGIN");
        await recusaProva(db, usuarioId, empresaId);
        await db.query("ROLLBACK");
      } finally {
        await titular.query("ROLLBACK").catch(() => undefined);
        await outro.query("ROLLBACK").catch(() => undefined);
        await titular.end();
        await outro.end();
      }
    });
  } finally {
    try {
      await db.query("ROLLBACK");
    } catch {
      /* sem transação */
    }
    try {
      await limpar(db);
      const resto = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM empresas WHERE codigo LIKE 'hg8p%'");
      const legado = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pacotes WHERE empresa_id IS NULL");
      assert.equal(resto.rows[0].n, 0);
      assert.equal(legado.rows[0].n, 7);
    } finally {
      await encerrarDescartavel(db);
    }
  }
});
