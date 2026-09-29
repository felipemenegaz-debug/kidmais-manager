import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita, portaDescartavel, linhaDeBase, LINHA_DE_BASE_ATUAL } from "../comercial/postgres-descartavel.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migration045 = resolve(root, "database/migrations/20260926_045_ciclo_membership.sql");
const precheck045 = resolve(root, "database/checks/20260926_045_precheck.sql");
const postcheck045 = resolve(root, "database/checks/20260926_045_postcheck.sql");
const down045 = resolve(root, "database/rollback/20260926_045_ciclo_membership_down.sql");

function texto(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function codigo() {
  return `hg8m${randomBytes(4).toString("hex")}`;
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

async function base(client: Client) {
  const empresaId = (await client.query<{ id: string }>(
    `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa de membership', 'PROVISIONAMENTO') RETURNING id`,
    [codigo()],
  )).rows[0].id;
  const usuarioId = (await client.query<{ id: string }>(
    `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel)
     VALUES ($1, 'Membro de ciclo', $2, 'REPRESENTANTE_AUTORIZADO') RETURNING id`,
    [`${codigo()}@example.test`, senhaFalsa()],
  )).rows[0].id;
  const membershipId = (await client.query<{ id: string }>(
    `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde)
     VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp()) RETURNING id`,
    [empresaId, usuarioId],
  )).rows[0].id;
  return { empresaId, usuarioId, membershipId };
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
      assert.equal(terminou, false, "a sessão concorrente não ficou bloqueada");
    },
  };
}

async function limparSinteticos(client: Client) {
  await client.query("ALTER TABLE memberships DISABLE TRIGGER USER");
  await client.query("ALTER TABLE empresas DISABLE TRIGGER USER");
  try {
    await client.query(
      `DELETE FROM memberships
        WHERE empresa_id IN (SELECT id FROM empresas WHERE codigo LIKE 'hg8m%')
           OR usuario_id IN (SELECT id FROM usuarios_administrativos WHERE email LIKE 'hg8m%@example.test')`,
    );
    await client.query("DELETE FROM empresas WHERE codigo LIKE 'hg8m%'");
    await client.query("DELETE FROM usuarios_administrativos WHERE email LIKE 'hg8m%@example.test'");
  } finally {
    await client.query("ALTER TABLE empresas ENABLE TRIGGER USER");
    await client.query("ALTER TABLE memberships ENABLE TRIGGER USER");
  }
}

test("ciclo da membership no postgres descartável", { timeout: 120_000 }, async (t) => {
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    const ident = await db.query<{ db: string; port: number }>(
      "SELECT current_database() AS db, inet_server_port() AS port",
    );
    assert.equal(ident.rows[0].db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.rows[0].port), portaDescartavel());
    // D3: produto parte do estado canônico ATUAL restaurado pela receita (046 aplicada: legado atribuído à Kidmais).
    assert.deepEqual(await linhaDeBase(db), LINHA_DE_BASE_ATUAL, "estado canônico atual");

    const ja = await db.query<{ ok: boolean }>(
      "SELECT to_regprocedure('public.kidmais_045_guard_memberships()') IS NOT NULL AS ok",
    );
    if (!ja.rows[0].ok) {
      await db.query(readFileSync(precheck045, "utf8"));
      await db.query(readFileSync(migration045, "utf8"));
      await db.query(readFileSync(postcheck045, "utf8"));
    }

    await t.test("os estados aprovados passam e a revogação ocupa a unicidade", async () => {
      await db.query("BEGIN");
      try {
        const criada = await base(db);
        await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [criada.membershipId]);
        const ativa = await db.query<{ status: string; carimbo: boolean }>(
          "SELECT status, revogado_em IS NULL AS carimbo FROM memberships WHERE id = $1::uuid",
          [criada.membershipId],
        );
        assert.equal(ativa.rows[0].status, "ATIVA");
        assert.equal(ativa.rows[0].carimbo, true);
        await db.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [criada.membershipId]);
        const revogada = await db.query<{ status: string; carimbo: boolean }>(
          "SELECT status, revogado_em IS NOT NULL AS carimbo FROM memberships WHERE id = $1::uuid",
          [criada.membershipId],
        );
        assert.equal(revogada.rows[0].status, "REVOGADA");
        assert.equal(revogada.rows[0].carimbo, true);
        await recusa(
          db,
          `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde)
           VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp())`,
          [criada.empresaId, criada.usuarioId],
          "kidmais_043_memberships_empresa_usuario_uk",
        );
        await recusa(
          db,
          `UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`,
          [criada.membershipId],
          "045: transição de membership recusada.",
        );
        await recusa(
          db,
          `UPDATE memberships SET status = 'PENDENTE' WHERE id = $1::uuid`,
          [criada.membershipId],
          "045: transição de membership recusada.",
        );

        const pendente = await base(db);
        await db.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [pendente.membershipId]);
        await recusa(
          db,
          `UPDATE memberships SET status = 'REVOGADA', revogado_em = clock_timestamp() WHERE id = $1::uuid`,
          [(await base(db)).membershipId],
          "045: identidade da membership é imutável.",
        );
        await recusa(
          db,
          `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde)
           VALUES ($1::uuid, $2::uuid, 'SUSPENSA', clock_timestamp())`,
          [pendente.empresaId, (await db.query<{ id: string }>(
            `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel)
             VALUES ($1, 'Outro', $2, 'ADMINISTRATIVO') RETURNING id`,
            [`${codigo()}@example.test`, senhaFalsa()],
          )).rows[0].id],
          "045: membership nova começa pendente.",
        );
        const eventos = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM auditoria
            WHERE entidade_tipo = 'MEMBERSHIP' AND entidade_id = $1::uuid`,
          [criada.membershipId],
        );
        assert.equal(eventos.rows[0].n, 2);
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("duas sessões não ativam uma membership que a outra já revogou", async () => {
      const titular = await conectarDescartavel({ travar: false });
      const outro = await conectarDescartavel({ travar: false });
      let membershipId = "";
      try {
        await db.query("BEGIN");
        const criada = await base(db);
        membershipId = criada.membershipId;
        await db.query("COMMIT");

        await titular.query("BEGIN");
        await titular.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [membershipId]);
        const corrida = rastrear((async () => {
          await outro.query("BEGIN");
          await outro.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [membershipId]);
          await outro.query("COMMIT");
          return "ok";
        })());
        await corrida.aindaEspera();
        await titular.query("COMMIT");
        let message = "";
        try {
          await corrida.promessa;
          message = "passou";
        } catch (error) {
          message = texto(error);
        }
        assert.equal(message.includes("045: transição de membership recusada."), true, message);
        const final = await db.query<{ status: string }>(
          "SELECT status FROM memberships WHERE id = $1::uuid",
          [membershipId],
        );
        assert.equal(final.rows[0].status, "REVOGADA");
      } finally {
        await titular.query("ROLLBACK").catch(() => undefined);
        await outro.query("ROLLBACK").catch(() => undefined);
        await titular.end();
        await outro.end();
        await db.query("ROLLBACK").catch(() => undefined);
      }
    });

    await t.test("o down devolve a trava da 043 e o rollback reabre o ciclo", async () => {
      await db.query("BEGIN");
      try {
        await db.query(semTransacaoExplicita(readFileSync(down045, "utf8")));
        const criada = await base(db);
        await recusa(
          db,
          `UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`,
          [criada.membershipId],
          "043: ativação de membership ainda fechada.",
        );
      } finally {
        await db.query("ROLLBACK");
      }
      await db.query("BEGIN");
      try {
        const criada = await base(db);
        await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [criada.membershipId]);
        const status = await db.query<{ status: string }>(
          "SELECT status FROM memberships WHERE id = $1::uuid",
          [criada.membershipId],
        );
        assert.equal(status.rows[0].status, "ATIVA");
      } finally {
        await db.query("ROLLBACK");
      }
    });

    assert.deepEqual(await linhaDeBase(db), LINHA_DE_BASE_ATUAL, "linha de base intacta");
  } finally {
    try {
      await db.query("ROLLBACK");
    } catch {
      /* sem transação */
    }
    try {
      await limparSinteticos(db);
      const resto = await db.query<{ empresas: number; membros: number }>(
        `SELECT
           (SELECT count(*)::int FROM empresas WHERE codigo LIKE 'hg8m%') AS empresas,
           (SELECT count(*)::int FROM memberships m
              JOIN empresas e ON e.id = m.empresa_id
             WHERE e.codigo LIKE 'hg8m%') AS membros`,
      );
      assert.equal(resto.rows[0].empresas, 0);
      assert.equal(resto.rows[0].membros, 0);
    } finally {
      await encerrarDescartavel(db);
    }
  }
});
