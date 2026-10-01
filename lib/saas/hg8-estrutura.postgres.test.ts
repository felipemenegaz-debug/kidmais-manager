import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita, portaDescartavel } from "../comercial/postgres-descartavel.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migration043 = resolve(root, "database/migrations/20260926_043_estrutura_tenant.sql");
const precheck043 = resolve(root, "database/checks/20260926_043_precheck.sql");
const postcheck043 = resolve(root, "database/checks/20260926_043_postcheck.sql");
const down043 = resolve(root, "database/rollback/20260926_043_estrutura_tenant_down.sql");
const migration040 = resolve(root, "database/migrations/20260926_040_integridade_sem_excecao_nominal.sql");
const precheck040 = resolve(root, "database/checks/20260926_040_precheck.sql");

function texto(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function codigo(prefixo: string) {
  return `${prefixo}${randomBytes(4).toString("hex")}`;
}

function senhaFalsa() {
  return `scrypt$v=1$N=131072$r=8$p=1$${ "A".repeat(22) }==$${ "B".repeat(86) }==`;
}

function semComentario(comando: string) {
  return comando.split(/\r?\n/).filter((linha) => !linha.trim().startsWith("--")).join("\n");
}

function comandosSql(sql: string) {
  const comandos: string[] = [];
  let atual = "";
  let i = 0;
  let dollar: string | null = null;
  while (i < sql.length) {
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        atual += dollar;
        i += dollar.length;
        dollar = null;
        continue;
      }
      atual += sql[i];
      i += 1;
      continue;
    }
    if (sql[i] === "-" && sql[i + 1] === "-") {
      const fim = sql.indexOf("\n", i);
      const ate = fim === -1 ? sql.length : fim + 1;
      atual += sql.slice(i, ate);
      i = ate;
      continue;
    }
    if (sql[i] === "$") {
      const marca = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (marca) {
        dollar = marca[0];
        atual += dollar;
        i += dollar.length;
        continue;
      }
    }
    if (sql[i] === ";") {
      const texto = atual.trim();
      if (texto) comandos.push(texto);
      atual = "";
      i += 1;
      continue;
    }
    atual += sql[i];
    i += 1;
  }
  const resto = atual.trim();
  if (resto) comandos.push(resto);
  return comandos;
}

async function esperarInsertBloqueado(observador: Client, pid: number, terminou: () => boolean) {
  const inicio = Date.now();
  while (Date.now() - inicio < 8_000) {
    assert.equal(terminou(), false, "o insert concorrente confirmou enquanto o DOWN ainda segurava a trava");
    const espera = await observador.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_locks
        WHERE pid = $1
          AND NOT granted
          AND relation = 'public.memberships'::regclass`,
      [pid],
    );
    if (espera.rows[0].n > 0) return;
    await new Promise((resolver) => setTimeout(resolver, 20));
  }
  assert.fail("o insert concorrente não ficou bloqueado em memberships");
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

test("estrutura de tenant da 043 no postgres descartável", { timeout: 180_000 }, async (t) => {
  assert.equal(existsSync(resolve(root, "database/migrations/20260923_020_saas_foundation.sql")), false);
  const fonte = readFileSync(migration043, "utf8");
  assert.equal(fonte.includes("saas020_"), false);
  assert.equal(fonte.includes("runtime_roles"), false);
  assert.equal(fonte.includes("v1_pre_hash"), false);
  assert.equal(fonte.includes("unidade_id"), true);
  assert.equal(fonte.includes("043: membership nova começa pendente."), true);
  assert.equal(fonte.includes("043: ativação de membership ainda fechada."), true);

  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    const ident = await db.query<{ db: string; port: number }>(
      "SELECT current_database() AS db, inet_server_port() AS port",
    );
    assert.equal(ident.rows[0].db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.rows[0].port), portaDescartavel());

    const antes = await db.query<{ empresas: number; legado: number; vinculos: number }>(
      `SELECT
         (SELECT count(*)::int FROM empresas) AS empresas,
         (SELECT count(*)::int FROM pacotes WHERE empresa_id IS NULL) AS legado,
         (SELECT count(*)::int
            FROM pacote_adicionais pa
            JOIN pacotes p ON p.id = pa.pacote_id
            JOIN adicionais a ON a.id = pa.adicional_id
           WHERE p.codigo = 'FESTA_LOCAL'
             AND a.codigo = 'SALADA_PREMIUM'
             AND p.empresa_id IS NOT NULL
             AND a.empresa_id IS NULL) AS vinculos`,
    );

    const ja = await db.query<{ ok: boolean }>(
      "SELECT to_regclass('public.memberships') IS NOT NULL AS ok",
    );
    if (!ja.rows[0].ok) {
      await db.query(readFileSync(precheck043, "utf8"));
      await db.query(readFileSync(migration043, "utf8"));
      await db.query(readFileSync(postcheck043, "utf8"));
    }

    await t.test("a 043 não copia a 020 nem cria outra empresas", async () => {
      const forma = await db.query<{ empresas: number; papel: number; suspensa: boolean; unidade: boolean }>(
        `SELECT
           (SELECT count(*)::int FROM pg_class WHERE relname = 'empresas' AND relkind = 'r') AS empresas,
           (SELECT count(*)::int
              FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'memberships' AND column_name = 'papel') AS papel,
           position('SUSPENSA' IN pg_get_constraintdef(oid)) > 0 AS suspensa,
           EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'pacotes' AND column_name = 'unidade_id'
           ) AS unidade
         FROM pg_constraint
        WHERE conname = 'kidmais_043_memberships_status_ck'`,
      );
      assert.equal(forma.rows[0].empresas, 1);
      assert.equal(forma.rows[0].papel, 0);
      assert.equal(forma.rows[0].suspensa, false);
      assert.equal(forma.rows[0].unidade, false);
      const funcoes = await db.query<{ saas: number }>(
        "SELECT count(*)::int AS saas FROM pg_proc WHERE proname LIKE 'saas020_%'",
      );
      assert.equal(funcoes.rows[0].saas, 0);
    });

    await t.test("membership nasce pendente e o INSERT ATIVA continua fechado", async () => {
      await db.query("BEGIN");
      try {
        const empresa = await db.query<{ id: string }>(
          `INSERT INTO empresas (codigo, nome, status)
           VALUES ($1, 'Empresa estrutural', 'PROVISIONAMENTO')
           RETURNING id`,
          [codigo("hg8e")],
        );
        const usuario = await db.query<{ id: string }>(
          `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel)
           VALUES ($1, 'Usuario estrutural', $2, 'REPRESENTANTE_AUTORIZADO')
           RETURNING id`,
          [`${codigo("hg8u")}@example.test`, senhaFalsa()],
        );
        const pendente = await db.query<{ status: string }>(
          `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde)
           VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp())
           RETURNING status`,
          [empresa.rows[0].id, usuario.rows[0].id],
        );
        assert.equal(pendente.rows[0].status, "PENDENTE");
        await recusa(
          db,
          `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde)
           VALUES ($1::uuid, $2::uuid, 'ATIVA', clock_timestamp())`,
          [empresa.rows[0].id, usuario.rows[0].id],
          "membership nova começa pendente.",
        );
        const cicloAberto = await db.query<{ ok: boolean }>(
          "SELECT to_regprocedure('kidmais_045_guard_memberships()') IS NOT NULL AS ok",
        );
        if (!cicloAberto.rows[0].ok) {
          await recusa(
            db,
            `UPDATE memberships SET status = 'ATIVA' WHERE empresa_id = $1::uuid`,
            [empresa.rows[0].id],
            "043: ativação de membership ainda fechada.",
          );
          await recusa(
            db,
            `UPDATE memberships SET status = 'REVOGADA', revogado_em = clock_timestamp() WHERE empresa_id = $1::uuid`,
            [empresa.rows[0].id],
            "043: ativação de membership ainda fechada.",
          );
        } else {
          const guarda043 = await db.query<{ ok: boolean }>(
            "SELECT to_regprocedure('kidmais_043_guard_memberships()') IS NOT NULL AS ok",
          );
          assert.equal(guarda043.rows[0].ok, true);
          await recusa(
            db,
            `UPDATE memberships SET status = 'REVOGADA', revogado_em = clock_timestamp() WHERE empresa_id = $1::uuid`,
            [empresa.rows[0].id],
            "revogado_em não é carimbado pelo chamador.",
          );
        }
        const outro = await db.query<{ id: string }>(
          `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel)
           VALUES ($1, 'Outro usuario', $2, 'ADMINISTRATIVO')
           RETURNING id`,
          [`${codigo("hg8v")}@example.test`, senhaFalsa()],
        );
        await db.query(
          `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde)
           VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp())`,
          [empresa.rows[0].id, outro.rows[0].id],
        );
        await recusa(
          db,
          `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde)
           VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp())`,
          [empresa.rows[0].id, outro.rows[0].id],
          "kidmais_043_memberships_empresa_usuario_uk",
        );
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("estabelecimento nasce suspenso e o vínculo cruzado é recusado", async () => {
      await db.query("BEGIN");
      try {
        const empresaA = (await db.query<{ id: string }>(
          `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa A', 'PROVISIONAMENTO') RETURNING id`,
          [codigo("hg8a")],
        )).rows[0].id;
        const empresaB = (await db.query<{ id: string }>(
          `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa B', 'PROVISIONAMENTO') RETURNING id`,
          [codigo("hg8b")],
        )).rows[0].id;
        const unidadeA = (await db.query<{ id: string; status: string }>(
          `INSERT INTO estabelecimentos (empresa_id, codigo, nome, status)
           VALUES ($1::uuid, $2, 'Unidade A', 'SUSPENSO')
           RETURNING id, status`,
          [empresaA, codigo("hg8s")],
        )).rows[0];
        assert.equal(unidadeA.status, "SUSPENSO");
        await recusa(
          db,
          `INSERT INTO estabelecimentos (empresa_id, codigo, nome, status)
           VALUES ($1::uuid, $2, 'Unidade ativa', 'ATIVO')`,
          [empresaA, codigo("hg8t")],
          "043: estabelecimento novo começa suspenso.",
        );
        await recusa(
          db,
          `UPDATE estabelecimentos SET status = 'ATIVO' WHERE id = $1::uuid`,
          [unidadeA.id],
          "043: estabelecimento permanece não operacional.",
        );
        const usuario = (await db.query<{ id: string }>(
          `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel)
           VALUES ($1, 'Membro', $2, 'REPRESENTANTE_AUTORIZADO') RETURNING id`,
          [`${codigo("hg8m")}@example.test`, senhaFalsa()],
        )).rows[0].id;
        const membershipA = (await db.query<{ id: string }>(
          `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde)
           VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp()) RETURNING id`,
          [empresaA, usuario],
        )).rows[0].id;
        const membershipB = (await db.query<{ id: string }>(
          `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde)
           VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp()) RETURNING id`,
          [empresaB, (await db.query<{ id: string }>(
            `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel)
             VALUES ($1, 'Membro B', $2, 'ADMINISTRATIVO') RETURNING id`,
            [`${codigo("hg8n")}@example.test`, senhaFalsa()],
          )).rows[0].id],
        )).rows[0].id;
        await recusa(
          db,
          `INSERT INTO membership_estabelecimentos (
             empresa_id, estabelecimento_id, membership_id, status, vigente_desde
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'SUSPENSA', clock_timestamp())`,
          [empresaA, unidadeA.id, membershipB],
          "kidmais_043_me_membership_fk",
        );
        await recusa(
          db,
          `INSERT INTO membership_estabelecimentos (
             empresa_id, estabelecimento_id, membership_id, status, vigente_desde
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'SUSPENSA', clock_timestamp())`,
          [empresaB, unidadeA.id, membershipB],
          "kidmais_043_me_estabelecimento_fk",
        );
        const mesmo = await db.query<{ status: string }>(
          `INSERT INTO membership_estabelecimentos (
             empresa_id, estabelecimento_id, membership_id, status, vigente_desde
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'SUSPENSA', clock_timestamp())
           RETURNING status`,
          [empresaA, unidadeA.id, membershipA],
        );
        assert.equal(mesmo.rows[0].status, "SUSPENSA");
        await recusa(
          db,
          `INSERT INTO membership_estabelecimentos (
             empresa_id, estabelecimento_id, membership_id, status, vigente_desde
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'ATIVA', clock_timestamp())`,
          [empresaA, unidadeA.id, membershipA],
          "043: vínculo de unidade nasce suspenso.",
        );
        await recusa(
          db,
          `UPDATE membership_estabelecimentos SET status = 'ATIVA'
            WHERE membership_id = $1::uuid`,
          [membershipA],
          "043: caminho operacional da unidade permanece fechado.",
        );
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("o down da 043 recusa tabela preenchida e preserva a linha", async () => {
      const codigoEmpresa = codigo("hg8d");
      const email = `${codigo("hg8d")}@example.test`;
      await db.query(
        `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa do down', 'PROVISIONAMENTO')`,
        [codigoEmpresa],
      );
      const empresaId = (await db.query<{ id: string }>(
        "SELECT id FROM empresas WHERE codigo = $1",
        [codigoEmpresa],
      )).rows[0].id;
      const usuarioId = (await db.query<{ id: string }>(
        `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel)
         VALUES ($1, 'Usuario do down', $2, 'REPRESENTANTE_AUTORIZADO') RETURNING id`,
        [email, senhaFalsa()],
      )).rows[0].id;
      const membershipId = (await db.query<{ id: string }>(
        `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde)
         VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp()) RETURNING id`,
        [empresaId, usuarioId],
      )).rows[0].id;
      try {
        let message = "";
        await db.query("BEGIN");
        try {
          await db.query(semTransacaoExplicita(readFileSync(down043, "utf8")));
          message = "passou";
        } catch (error) {
          message = texto(error);
        }
        await db.query("ROLLBACK");
        assert.match(message, /043 down: rollback recusado porque a Foundation já tem dado/);
        const preservada = await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM memberships WHERE id = $1::uuid",
          [membershipId],
        );
        assert.equal(preservada.rows[0].n, 1);
        const estrutura = await db.query<{ ok: boolean }>(
          `SELECT to_regclass('public.memberships') IS NOT NULL
              AND to_regclass('public.estabelecimentos') IS NOT NULL
              AND to_regclass('public.membership_estabelecimentos') IS NOT NULL AS ok`,
        );
        assert.equal(estrutura.rows[0].ok, true);
      } finally {
        await db.query("ROLLBACK").catch(() => undefined);
        await db.query("ALTER TABLE memberships DISABLE TRIGGER USER");
        await db.query("ALTER TABLE empresas DISABLE TRIGGER USER");
        try {
          await db.query("DELETE FROM memberships WHERE id = $1::uuid", [membershipId]);
          await db.query("DELETE FROM empresas WHERE id = $1::uuid", [empresaId]);
          await db.query("DELETE FROM usuarios_administrativos WHERE id = $1::uuid", [usuarioId]);
        } finally {
          await db.query("ALTER TABLE empresas ENABLE TRIGGER USER");
          await db.query("ALTER TABLE memberships ENABLE TRIGGER USER");
        }
      }
    });

    await t.test("o down da 043 sai numa transação desfeita e a estrutura volta", async () => {
      await db.query("BEGIN");
      try {
        await db.query(semTransacaoExplicita(readFileSync(down043, "utf8")));
        const ausente = await db.query<{ ok: boolean }>(
          `SELECT to_regclass('public.estabelecimentos') IS NULL
              AND to_regclass('public.memberships') IS NULL
              AND to_regclass('public.membership_estabelecimentos') IS NULL
              AND to_regclass('public.empresas') IS NOT NULL AS ok`,
        );
        assert.equal(ausente.rows[0].ok, true);
      } finally {
        await db.query("ROLLBACK");
      }
      const presente = await db.query<{ ok: boolean }>(
        `SELECT to_regclass('public.memberships') IS NOT NULL
            AND to_regprocedure('public.kidmais_043_guard_memberships()') IS NOT NULL
            AND to_regprocedure('public.kidmais_031_guard_empresas()') IS NOT NULL AS ok`,
      );
      assert.equal(presente.rows[0].ok, true);
    });

    await t.test("o insert concorrente não entra entre o vazio e o drop", async () => {
      const fonte = readFileSync(down043, "utf8");
      assert.equal(
        /DELETE\s+FROM\s+(public\.)?(estabelecimentos|memberships|membership_estabelecimentos)\b/i.test(fonte),
        false,
      );
      const comandos = comandosSql(semTransacaoExplicita(fonte));
      const trava = comandos.findIndex((comando) => /LOCK TABLE/i.test(semComentario(comando)));
      const vazio = comandos.findIndex((comando) => /SELECT count\(\*\)/i.test(semComentario(comando)));
      const drop = comandos.findIndex((comando) => /^\s*DROP TABLE\b/im.test(semComentario(comando)));
      assert.equal(trava >= 0 && vazio > trava && drop > vazio, true);
      const ordem = comandos[trava];
      const posEstabelecimentos = ordem.indexOf("'estabelecimentos'");
      const posMemberships = ordem.indexOf("'memberships'");
      const posUnidades = ordem.indexOf("'membership_estabelecimentos'");
      assert.equal(
        posEstabelecimentos >= 0 && posEstabelecimentos < posMemberships && posMemberships < posUnidades,
        true,
      );
      const ocupacao = await db.query<{ n: number }>(
        `SELECT
           (SELECT count(*)::int FROM estabelecimentos)
           + (SELECT count(*)::int FROM memberships)
           + (SELECT count(*)::int FROM membership_estabelecimentos) AS n`,
      );
      assert.equal(ocupacao.rows[0].n, 0);
      const codigoEmpresa = codigo("hg8r");
      const email = `${codigo("hg8r")}@example.test`;
      await db.query(
        `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa da corrida', 'PROVISIONAMENTO')`,
        [codigoEmpresa],
      );
      const empresaId = (await db.query<{ id: string }>(
        "SELECT id FROM empresas WHERE codigo = $1",
        [codigoEmpresa],
      )).rows[0].id;
      const usuarioId = (await db.query<{ id: string }>(
        `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel)
         VALUES ($1, 'Usuario da corrida', $2, 'REPRESENTANTE_AUTORIZADO') RETURNING id`,
        [email, senhaFalsa()],
      )).rows[0].id;
      const t1 = await conectarDescartavel({ travar: false });
      const t2 = await conectarDescartavel({ travar: false });
      const t2pid = Number((await t2.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      let terminou = false;
      let resultadoInsert = "";
      let insercao = Promise.resolve();
      let membershipId = "";
      try {
        await t1.query("BEGIN");
        for (let i = 0; i <= trava; i += 1) await t1.query(comandos[i]);
        const modos = await t1.query<{ relname: string; mode: string }>(
          `SELECT c.relname, l.mode
             FROM pg_locks l
             JOIN pg_class c ON c.oid = l.relation
            WHERE l.pid = pg_backend_pid()
              AND l.granted
              AND c.relkind = 'r'
              AND c.relname = ANY($1::text[])`,
          [["estabelecimentos", "memberships", "membership_estabelecimentos"]],
        );
        assert.deepEqual(
          [...new Set(modos.rows.map((linha) => linha.relname))].sort(),
          ["estabelecimentos", "membership_estabelecimentos", "memberships"],
        );
        assert.equal(modos.rows.every((linha) => linha.mode === "AccessExclusiveLock"), true);
        insercao = (async () => {
          try {
            await t2.query("BEGIN");
            await t2.query(
              `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde)
               VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp())`,
              [empresaId, usuarioId],
            );
            await t2.query("COMMIT");
            resultadoInsert = "ok";
          } catch (error) {
            resultadoInsert = texto(error);
            await t2.query("ROLLBACK").catch(() => undefined);
          } finally {
            terminou = true;
          }
        })();
        await esperarInsertBloqueado(db, t2pid, () => terminou);
        for (let i = trava + 1; i <= vazio; i += 1) await t1.query(comandos[i]);
        const vista = await t1.query<{ n: number }>("SELECT count(*)::int AS n FROM memberships");
        assert.equal(vista.rows[0].n, 0);
        assert.equal(terminou, false);
        for (let i = vazio + 1; i < comandos.length; i += 1) await t1.query(comandos[i]);
        const derrubada = await t1.query<{ ok: boolean }>(
          `SELECT to_regclass('public.estabelecimentos') IS NULL
              AND to_regclass('public.memberships') IS NULL
              AND to_regclass('public.membership_estabelecimentos') IS NULL AS ok`,
        );
        assert.equal(derrubada.rows[0].ok, true);
        assert.equal(terminou, false);
        await t1.query("ROLLBACK");
        await insercao;
        assert.equal(resultadoInsert, "ok");
        const preservada = await db.query<{ id: string }>(
          "SELECT id FROM memberships WHERE empresa_id = $1::uuid AND usuario_id = $2::uuid",
          [empresaId, usuarioId],
        );
        assert.equal(preservada.rows.length, 1);
        membershipId = preservada.rows[0].id;
        const estrutura = await db.query<{ ok: boolean }>(
          `SELECT to_regclass('public.memberships') IS NOT NULL
              AND to_regclass('public.estabelecimentos') IS NOT NULL
              AND to_regclass('public.membership_estabelecimentos') IS NOT NULL
              AND to_regprocedure('public.kidmais_043_guard_memberships()') IS NOT NULL AS ok`,
        );
        assert.equal(estrutura.rows[0].ok, true);
      } finally {
        await insercao.catch(() => undefined);
        await t1.query("ROLLBACK").catch(() => undefined);
        await t2.query("ROLLBACK").catch(() => undefined);
        await t1.end();
        await t2.end();
        await db.query("ROLLBACK").catch(() => undefined);
        await db.query("ALTER TABLE memberships DISABLE TRIGGER USER");
        await db.query("ALTER TABLE empresas DISABLE TRIGGER USER");
        try {
          if (membershipId) await db.query("DELETE FROM memberships WHERE id = $1::uuid", [membershipId]);
          await db.query("DELETE FROM memberships WHERE empresa_id = $1::uuid", [empresaId]);
          await db.query("DELETE FROM empresas WHERE id = $1::uuid", [empresaId]);
          await db.query("DELETE FROM usuarios_administrativos WHERE id = $1::uuid", [usuarioId]);
        } finally {
          await db.query("ALTER TABLE empresas ENABLE TRIGGER USER");
          await db.query("ALTER TABLE memberships ENABLE TRIGGER USER");
        }
      }
    });

    await t.test("a 040 continua abortando em vínculo incompatível e não o reescreve", async () => {
      await db.query("BEGIN");
      let message = "";
      try {
        await db.query("ALTER TABLE pacote_adicionais DISABLE TRIGGER pacote_adicionais_empresa_trg");
        const empresaId = (await db.query<{ id: string }>(
          `INSERT INTO empresas (codigo, nome, status)
           VALUES ('hg8v040a', 'Empresa da prova', 'PROVISIONAMENTO') RETURNING id`,
        )).rows[0].id;
        const pacoteId = (await db.query<{ id: string }>(
          `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente)
           VALUES ($1::uuid, 'hg8v040p', 'Pacote da prova', 400, true, true) RETURNING id`,
          [empresaId],
        )).rows[0].id;
        const adicionalId = (await db.query<{ id: string }>(
          `INSERT INTO adicionais (empresa_id, codigo, nome, categoria, categoria_id, unidade_cobranca, ordem_exibicao)
           SELECT NULL, 'hg8v040d', 'Adicional da prova', categoria, categoria_id, unidade_cobranca, 400
             FROM adicionais WHERE codigo = 'SALADA_PREMIUM' RETURNING id`,
        )).rows[0].id;
        await db.query(
          `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade)
           VALUES ($1::uuid, $2::uuid, 'EXTRA')`,
          [pacoteId, adicionalId],
        );
        try {
          await db.query(semTransacaoExplicita(readFileSync(precheck040, "utf8")));
          message = "passou";
        } catch (error) {
          message = texto(error);
        }
        assert.match(message, /040 precheck: vínculo incompatível/);
        await db.query("ROLLBACK");
        await db.query("BEGIN");
        await db.query("ALTER TABLE pacote_adicionais DISABLE TRIGGER pacote_adicionais_empresa_trg");
        const empresaB = (await db.query<{ id: string }>(
          `INSERT INTO empresas (codigo, nome, status)
           VALUES ('hg8v040b', 'Empresa da prova', 'PROVISIONAMENTO') RETURNING id`,
        )).rows[0].id;
        const pacoteB = (await db.query<{ id: string }>(
          `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente)
           VALUES ($1::uuid, 'hg8v040q', 'Pacote da prova', 400, true, true) RETURNING id`,
          [empresaB],
        )).rows[0].id;
        const adicionalB = (await db.query<{ id: string }>(
          `INSERT INTO adicionais (empresa_id, codigo, nome, categoria, categoria_id, unidade_cobranca, ordem_exibicao)
           SELECT NULL, 'hg8v040e', 'Adicional da prova', categoria, categoria_id, unidade_cobranca, 400
             FROM adicionais WHERE codigo = 'SALADA_PREMIUM' RETURNING id`,
        )).rows[0].id;
        await db.query(
          `INSERT INTO pacote_adicionais (pacote_id, adicional_id, modalidade)
           VALUES ($1::uuid, $2::uuid, 'EXTRA')`,
          [pacoteB, adicionalB],
        );
        message = "";
        try {
          await db.query(semTransacaoExplicita(readFileSync(migration040, "utf8")));
          message = "passou";
        } catch (error) {
          message = texto(error);
        }
        assert.match(message, /040: vínculo incompatível/);
      } finally {
        await db.query("ROLLBACK");
      }
    });

    const depois = await db.query<{ empresas: number; legado: number; vinculos: number; kidmais: number }>(
      `SELECT
         (SELECT count(*)::int FROM empresas) AS empresas,
         (SELECT count(*)::int FROM pacotes WHERE empresa_id IS NULL) AS legado,
         (SELECT count(*)::int
            FROM pacote_adicionais pa
            JOIN pacotes p ON p.id = pa.pacote_id
            JOIN adicionais a ON a.id = pa.adicional_id
           WHERE p.codigo = 'FESTA_LOCAL'
             AND a.codigo = 'SALADA_PREMIUM'
             AND p.empresa_id IS NOT NULL
             AND a.empresa_id IS NULL) AS vinculos,
         (SELECT count(*)::int FROM empresas WHERE codigo ILIKE '%kidmais%' OR nome ILIKE '%kidmais%') AS kidmais`,
    );
    assert.equal(depois.rows[0].empresas, antes.rows[0].empresas);
    assert.equal(depois.rows[0].legado, 7);
    assert.equal(depois.rows[0].vinculos, antes.rows[0].vinculos);
    assert.equal(depois.rows[0].kidmais, 0);
    assert.equal(antes.rows[0].legado, 7);
    assert.equal(antes.rows[0].vinculos, 0);
  } finally {
    await encerrarDescartavel(db);
  }
});
