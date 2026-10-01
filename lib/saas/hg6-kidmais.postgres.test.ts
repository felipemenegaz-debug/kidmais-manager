import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita, portaDescartavel } from "../comercial/postgres-descartavel.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migration046 = resolve(root, "database/migrations/20260926_046_kidmais_legado_controlado.sql");
const precheck046 = resolve(root, "database/checks/20260926_046_precheck.sql");
const postcheck046 = resolve(root, "database/checks/20260926_046_postcheck.sql");
const down046 = resolve(root, "database/rollback/20260926_046_kidmais_legado_controlado_down.sql");
const migration040 = resolve(root, "database/migrations/20260926_040_integridade_sem_excecao_nominal.sql");
const postcheck040 = resolve(root, "database/checks/20260926_040_postcheck.sql");
const uuidProvado = "09e88db0-ad25-4603-ad9a-bf61887dbe0e";

function texto(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function senhaFalsa() {
  return `scrypt$v=1$N=131072$r=8$p=1$${ "A".repeat(22) }==$${ "B".repeat(86) }==`;
}

function emailDaMigration(fonte: string) {
  const found = fonte.match(/email_alvo text := '([^']+)';/);
  if (!found) throw new Error("lookup de e-mail ausente");
  return found[1];
}

async function usuario(client: Client, email: string, papel: string, ativo: boolean) {
  await client.query(
    `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo)
     VALUES ($1, 'Representante de prova', $2, $3, $4)`,
    [email, senhaFalsa(), papel, ativo],
  );
}

test("atribuição controlada da Kidmais no postgres descartável", { timeout: 120_000 }, async (t) => {
  const fonte = readFileSync(migration046, "utf8");
  const email = emailDaMigration(fonte);
  assert.equal(fonte.includes(uuidProvado), false);
  assert.equal(fonte.includes("FESTA_LOCAL"), false);
  assert.equal(fonte.includes("DISABLE TRIGGER USER"), false);
  assert.equal(fonte.includes("ENABLE TRIGGER pacotes_empresa_imutavel_trg"), true);
  const sintetica = readFileSync(resolve(root, "lib/saas/provisionar-tenant.ts"), "utf8");
  assert.equal(sintetica.includes('texto.includes("kidmais")'), true);

  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    const ident = await db.query<{ db: string; port: number }>(
      "SELECT current_database() AS db, inet_server_port() AS port",
    );
    assert.equal(ident.rows[0].db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.rows[0].port), portaDescartavel());

    await t.test("e-mail divergente ou incompleto falha fechado e não grava a marca", async () => {
      await db.query("BEGIN");
      try {
        let message = "";
        try {
          await db.query(semTransacaoExplicita(fonte));
          message = "passou";
        } catch (error) {
          message = texto(error);
        }
        assert.match(message, /046: a identidade administrativa não é única/);
        await db.query("ROLLBACK");
        await db.query("BEGIN");
        await usuario(db, "hg6sintetico@example.test", "REPRESENTANTE_AUTORIZADO", true);
        message = "";
        try {
          await db.query(semTransacaoExplicita(fonte));
          message = "passou";
        } catch (error) {
          message = texto(error);
        }
        assert.match(message, /046: a identidade administrativa não é única/);
        await db.query("ROLLBACK");
        await db.query("BEGIN");
        await usuario(db, email, "REPRESENTANTE_AUTORIZADO", false);
        message = "";
        try {
          await db.query(semTransacaoExplicita(fonte));
          message = "passou";
        } catch (error) {
          message = texto(error);
        }
        assert.match(message, /046: a identidade administrativa não está ativa como representante autorizado/);
        await db.query("ROLLBACK");
        await db.query("BEGIN");
        await usuario(db, email, "ADMINISTRATIVO", true);
        message = "";
        try {
          await db.query(semTransacaoExplicita(fonte));
          message = "passou";
        } catch (error) {
          message = texto(error);
        }
        assert.match(message, /046: a identidade administrativa não está ativa como representante autorizado/);
      } finally {
        await db.query("ROLLBACK");
      }
      const gravado = await db.query<{ n: number; kidmais: number }>(
        `SELECT
           (SELECT count(*)::int FROM usuarios_administrativos WHERE lower(btrim(email)) = lower(btrim($1))) AS n,
           (SELECT count(*)::int FROM empresas WHERE codigo = 'kidmais') AS kidmais`,
        [email],
      );
      assert.equal(gravado.rows[0].n, 0);
      assert.equal(gravado.rows[0].kidmais, 0);
    });

    await t.test("a migration atribui o legado, a 040 passa e o rollback não deixa a identidade", async () => {
      const antes = await db.query<{ legado: number; soma: string; snapshots: number; representantes: number }>(
        `SELECT
           (SELECT count(*)::int FROM pacotes WHERE empresa_id IS NULL) AS legado,
           (SELECT coalesce(sum(valor), 0)::text FROM precos_pacote) AS soma,
           (SELECT count(*)::int FROM fechamento_pacote_snapshots) AS snapshots,
           (SELECT count(*)::int FROM usuarios_administrativos WHERE papel = 'REPRESENTANTE_AUTORIZADO' AND ativo) AS representantes`,
      );
      assert.equal(antes.rows[0].legado, 7);
      await db.query("BEGIN");
      try {
        await usuario(db, email, "REPRESENTANTE_AUTORIZADO", true);
        await db.query(readFileSync(precheck046, "utf8"));
        await db.query(semTransacaoExplicita(fonte));
        await db.query(readFileSync(postcheck046, "utf8"));
        const estado = await db.query<{ pacotes: number; salada: boolean; membership: string; papel: string }>(
          `SELECT
             (SELECT count(*)::int FROM pacotes p JOIN empresas e ON e.id = p.empresa_id
               WHERE e.codigo = 'kidmais'
                 AND p.codigo IN ('POCKET','MINI_FESTA','COMPACTA','ESSENCIAL','COMPLETA','PREMIUM','PIZZA_PARTY')) AS pacotes,
             EXISTS (
               SELECT 1 FROM adicionais a
                 JOIN empresas e ON e.id = a.empresa_id
                WHERE a.codigo = 'SALADA_PREMIUM' AND e.codigo = 'kidmais'
             ) AS salada,
             (SELECT m.status FROM memberships m JOIN empresas e ON e.id = m.empresa_id WHERE e.codigo = 'kidmais') AS membership,
             (SELECT papel FROM usuarios_administrativos WHERE lower(btrim(email)) = lower(btrim($1))) AS papel`,
          [email],
        );
        assert.equal(estado.rows[0].pacotes, 7);
        assert.equal(estado.rows[0].salada, true);
        assert.equal(estado.rows[0].membership, "ATIVA");
        assert.equal(estado.rows[0].papel, "REPRESENTANTE_AUTORIZADO");
        const precos = await db.query<{ soma: string; snapshots: number }>(
          `SELECT
             (SELECT coalesce(sum(valor), 0)::text FROM precos_pacote) AS soma,
             (SELECT count(*)::int FROM fechamento_pacote_snapshots) AS snapshots`,
        );
        assert.equal(precos.rows[0].soma, antes.rows[0].soma);
        assert.equal(precos.rows[0].snapshots, antes.rows[0].snapshots);
        await db.query("SAVEPOINT recusa");
        let message = "";
        try {
          await db.query("UPDATE pacotes SET empresa_id = NULL WHERE codigo = 'COMPACTA'");
          message = "passou";
        } catch (error) {
          message = texto(error);
        }
        await db.query("ROLLBACK TO SAVEPOINT recusa");
        assert.match(message, /036:/);
        await db.query(semTransacaoExplicita(readFileSync(migration040, "utf8")));
        await db.query(readFileSync(postcheck040, "utf8"));
        const guarda = await db.query<{ lista: boolean }>(
          `SELECT position('FESTA_LOCAL' IN pg_get_functiondef('public.kidmais_040_falhar_se_incompativel()'::regprocedure)) > 0
               OR position('FESTA_LOCAL' IN pg_get_functiondef('public.kidmais_038_falhar_se_incompativel()'::regprocedure)) > 0 AS lista`,
        );
        assert.equal(guarda.rows[0].lista, false);
        await db.query("SAVEPOINT down");
        message = "";
        try {
          await db.query(semTransacaoExplicita(readFileSync(down046, "utf8")));
          message = "passou";
        } catch (error) {
          message = texto(error);
        }
        await db.query("ROLLBACK TO SAVEPOINT down");
        assert.match(message, /046: a atribuição da Kidmais não é desfeita/);
      } finally {
        await db.query("ROLLBACK");
      }
      const depois = await db.query<{
        legado: number;
        kidmais: number;
        email: number;
        guarda: boolean;
        representantes: number;
        gatilho: boolean;
      }>(
        `SELECT
           (SELECT count(*)::int FROM pacotes WHERE empresa_id IS NULL) AS legado,
           (SELECT count(*)::int FROM empresas WHERE codigo = 'kidmais') AS kidmais,
           (SELECT count(*)::int FROM usuarios_administrativos WHERE lower(btrim(email)) = lower(btrim($1))) AS email,
           to_regprocedure('public.kidmais_040_falhar_se_incompativel()') IS NOT NULL AS guarda,
           (SELECT count(*)::int FROM usuarios_administrativos WHERE papel = 'REPRESENTANTE_AUTORIZADO' AND ativo) AS representantes,
           EXISTS (
             SELECT 1 FROM pg_trigger
              WHERE tgname = 'pacotes_empresa_imutavel_trg' AND NOT tgisinternal AND tgenabled = 'O'
           ) AS gatilho`,
        [email],
      );
      assert.equal(depois.rows[0].legado, 7);
      assert.equal(depois.rows[0].kidmais, 0);
      assert.equal(depois.rows[0].email, 0);
      assert.equal(depois.rows[0].guarda, false);
      assert.equal(depois.rows[0].representantes, antes.rows[0].representantes);
      assert.equal(depois.rows[0].gatilho, true);
    });
  } finally {
    await encerrarDescartavel(db);
  }
});
