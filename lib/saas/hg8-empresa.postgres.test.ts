import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "../comercial/postgres-descartavel.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migration044 = resolve(root, "database/migrations/20260926_044_ciclo_empresa.sql");
const precheck044 = resolve(root, "database/checks/20260926_044_precheck.sql");
const postcheck044 = resolve(root, "database/checks/20260926_044_postcheck.sql");
const down044 = resolve(root, "database/rollback/20260926_044_ciclo_empresa_down.sql");

function texto(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function codigo() {
  return `hg8c${randomBytes(4).toString("hex")}`;
}

function senhaFalsa() {
  return `scrypt$v=1$N=131072$r=8$p=1$${ "A".repeat(22) }==$${ "B".repeat(86) }==`;
}

async function recusa(client: Client, sql: string, params: unknown[], trecho: string) {
  await client.query("SAVEPOINT prova");
  let message = "";
  try {
    await client.query(sql, params);
    message = "passou";
  } catch (error) {
    message = texto(error);
  }
  await client.query("ROLLBACK TO SAVEPOINT prova");
  assert.equal(message.includes(trecho), true, message);
}

async function empresa(client: Client) {
  const criada = await client.query<{ id: string }>(
    `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa de ciclo', 'PROVISIONAMENTO') RETURNING id`,
    [codigo()],
  );
  return criada.rows[0].id;
}

async function transitar(client: Client, id: string, status: string) {
  await client.query(`UPDATE empresas SET status = $2 WHERE id = $1::uuid`, [id, status]);
}

async function auditoria(client: Client, id: string) {
  return client.query<{ antes: { status: string }; depois: { status: string }; ator: string; chaves: string[] }>(
    `SELECT dados_antes AS antes, dados_depois AS depois, ator_tipo AS ator,
            ARRAY(SELECT jsonb_object_keys(dados_depois)) AS chaves
       FROM auditoria
      WHERE entidade_tipo = 'EMPRESA' AND entidade_id = $1::uuid
      ORDER BY criado_em, id`,
    [id],
  );
}

test("ciclo da empresa no postgres descartável", { timeout: 120_000 }, async (t) => {
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    const ident = await db.query<{ db: string; port: number }>(
      "SELECT current_database() AS db, inet_server_port() AS port",
    );
    assert.equal(ident.rows[0].db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.rows[0].port), 55498);

    const ja = await db.query<{ ok: boolean }>(
      "SELECT to_regprocedure('public.kidmais_044_guard_empresas()') IS NOT NULL AS ok",
    );
    if (!ja.rows[0].ok) {
      await db.query(readFileSync(precheck044, "utf8"));
      await db.query(readFileSync(migration044, "utf8"));
      await db.query(readFileSync(postcheck044, "utf8"));
    }

    const legadoAntes = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pacotes WHERE empresa_id IS NULL");

    await t.test("só as transições aprovadas passam e cada uma é auditada", async () => {
      await db.query("BEGIN");
      try {
        const direta = await empresa(db);
        await transitar(db, direta, "DESATIVADA");
        const desligada = await db.query<{ status: string; carimbo: boolean }>(
          `SELECT status, desativado_em IS NOT NULL AS carimbo FROM empresas WHERE id = $1::uuid`,
          [direta],
        );
        assert.equal(desligada.rows[0].status, "DESATIVADA");
        assert.equal(desligada.rows[0].carimbo, true);
        const trilhaDireta = await auditoria(db, direta);
        assert.equal(trilhaDireta.rows.length, 1);
        assert.equal(trilhaDireta.rows[0].antes.status, "PROVISIONAMENTO");
        assert.equal(trilhaDireta.rows[0].depois.status, "DESATIVADA");
        assert.equal(trilhaDireta.rows[0].ator, "SISTEMA");
        assert.deepEqual(trilhaDireta.rows[0].chaves, ["status"]);

        const longa = await empresa(db);
        await transitar(db, longa, "ATIVA");
        await transitar(db, longa, "SUSPENSA");
        await transitar(db, longa, "DESATIVADA");
        const trilha = await auditoria(db, longa);
        const final = await db.query<{ status: string }>("SELECT status FROM empresas WHERE id = $1::uuid", [longa]);
        assert.equal(final.rows[0].status, "DESATIVADA");
        assert.deepEqual(
          trilha.rows.map((row) => `${row.antes.status}->${row.depois.status}`).sort(),
          ["ATIVA->SUSPENSA", "PROVISIONAMENTO->ATIVA", "SUSPENSA->DESATIVADA"],
        );

        const ativa = await empresa(db);
        await transitar(db, ativa, "ATIVA");
        await transitar(db, ativa, "DESATIVADA");
        const atalho = await auditoria(db, ativa);
        assert.deepEqual(atalho.rows.map((row) => row.depois.status), ["ATIVA", "DESATIVADA"]);
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("reativação, salto e carimbo do chamador são recusados", async () => {
      await db.query("BEGIN");
      try {
        const id = await empresa(db);
        await recusa(db, `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Nova', 'ATIVA')`, [codigo()], "044: empresa nova começa em PROVISIONAMENTO.");
        await recusa(db, `INSERT INTO empresas (codigo, nome, status, desativado_em) VALUES ($1, 'Nova', 'PROVISIONAMENTO', clock_timestamp())`, [codigo()], "044: empresa nova começa em PROVISIONAMENTO.");
        await recusa(db, `UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1::uuid`, [id], "044: transição de empresa recusada.");
        await transitar(db, id, "ATIVA");
        await recusa(db, `UPDATE empresas SET status = 'PROVISIONAMENTO' WHERE id = $1::uuid`, [id], "044: transição de empresa recusada.");
        await transitar(db, id, "SUSPENSA");
        await recusa(db, `UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [id], "044: transição de empresa recusada.");
        await recusa(db, `UPDATE empresas SET status = 'PROVISIONAMENTO' WHERE id = $1::uuid`, [id], "044: transição de empresa recusada.");
        await recusa(
          db,
          `UPDATE empresas SET status = 'DESATIVADA', desativado_em = clock_timestamp() WHERE id = $1::uuid`,
          [id],
          "044: identidade da empresa é imutável.",
        );
        await transitar(db, id, "DESATIVADA");
        const carimbo = await db.query<{ ok: boolean }>(
          "SELECT desativado_em IS NOT NULL AS ok FROM empresas WHERE id = $1::uuid",
          [id],
        );
        assert.equal(carimbo.rows[0].ok, true);
        for (const status of ["ATIVA", "SUSPENSA", "PROVISIONAMENTO"]) {
          await recusa(db, `UPDATE empresas SET status = $2 WHERE id = $1::uuid`, [id, status], "044: transição de empresa recusada.");
        }
        await recusa(db, `UPDATE empresas SET desativado_em = NULL WHERE id = $1::uuid`, [id], "044: identidade da empresa é imutável.");
        await recusa(db, `DELETE FROM empresas WHERE id = $1::uuid`, [id], "044: exclusão física de empresa recusada.");
        const eventos = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM auditoria WHERE entidade_id = $1::uuid AND acao = 'EMPRESA_TRANSICAO'`,
          [id],
        );
        assert.equal(eventos.rows[0].n, 3);
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("a auditoria da transição volta atrás com a transação e aceita ator ativo", async () => {
      await db.query("BEGIN");
      try {
        const usuario = (await db.query<{ id: string }>(
          `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel)
           VALUES ($1, 'Ator do ciclo', $2, 'REPRESENTANTE_AUTORIZADO') RETURNING id`,
          [`${codigo()}@example.test`, senhaFalsa()],
        )).rows[0].id;
        const id = await empresa(db);
        await db.query("SELECT set_config('kidmais.ator_usuario_id', $1, true)", [usuario]);
        await transitar(db, id, "ATIVA");
        const evento = await db.query<{ ator: string; usuario: string }>(
          `SELECT ator_tipo AS ator, usuario_id::text AS usuario
             FROM auditoria WHERE entidade_id = $1::uuid`,
          [id],
        );
        assert.equal(evento.rows[0].ator, "USUARIO");
        assert.equal(evento.rows[0].usuario, usuario);
        await db.query("SAVEPOINT sem_ator");
        await db.query("SELECT set_config('kidmais.ator_usuario_id', '', true)");
        await transitar(db, id, "SUSPENSA");
        await db.query("ROLLBACK TO SAVEPOINT sem_ator");
        const n = await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM auditoria WHERE entidade_id = $1::uuid",
          [id],
        );
        assert.equal(n.rows[0].n, 1);
        const status = await db.query<{ status: string }>("SELECT status FROM empresas WHERE id = $1::uuid", [id]);
        assert.equal(status.rows[0].status, "ATIVA");
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("o down reapontar o gatilho para a 031 e o rollback devolve o ciclo", async () => {
      await db.query("BEGIN");
      try {
        await db.query(semTransacaoExplicita(readFileSync(down044, "utf8")));
        const id = await empresa(db);
        await transitar(db, id, "SUSPENSA");
        const solta = await db.query<{ status: string }>("SELECT status FROM empresas WHERE id = $1::uuid", [id]);
        assert.equal(solta.rows[0].status, "SUSPENSA");
        const antiga = await db.query<{ ok: boolean }>(
          `SELECT p.proname = 'kidmais_031_guard_empresas' AS ok
             FROM pg_trigger g
             JOIN pg_proc p ON p.oid = g.tgfoid
            WHERE g.tgname = 'empresas_guard_trg' AND NOT g.tgisinternal`,
        );
        assert.equal(antiga.rows[0].ok, true);
      } finally {
        await db.query("ROLLBACK");
      }
      const id = await db.query("BEGIN").then(() => empresa(db));
      try {
        await recusa(db, `UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1::uuid`, [id], "044: transição de empresa recusada.");
      } finally {
        await db.query("ROLLBACK");
      }
    });

    const legado = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pacotes WHERE empresa_id IS NULL");
    const sintetica = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM empresas WHERE codigo LIKE 'hg8c%'",
    );
    assert.equal(legado.rows[0].n, legadoAntes.rows[0].n);
    assert.equal(sintetica.rows[0].n, 0);
  } finally {
    await encerrarDescartavel(db);
  }
});
