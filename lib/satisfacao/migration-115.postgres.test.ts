import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, portaDescartavel, semTransacaoExplicita } from "../comercial/postgres-descartavel.ts";

/**
 * 115 no PostgreSQL descartável (modelo 111, sem a 115, com o 054). Tudo dentro de transações desfeitas: o banco sai como
 * entrou.
 *   - precheck com o 115 ausente; subida (cria o 115 e remove o 054); pós-check; reaplicação neutra; precheck conforme;
 *   - down (recria o 054 idêntico ao da 054 e remove o 115); down de novo (neutro); pós-check recusa; nova subida;
 *   - homônimos divergentes do 115 (colunas trocadas, DESC, único, parcial, INCLUDE, expressão, outra tabela, tabela com o
 *     nome) e do 054 (sem predicado, DESC, duas colunas, único, outra tabela, tabela com o nome): subida, precheck e down
 *     recusam sem alterar nada;
 *   - limite operacional real: com escrita aberta em fechamentos, a subida desiste pelo lock_timeout de 5 s.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ler = (p: string) => readFileSync(resolve(root, p), "utf8");
const UP = ler("database/migrations/20261103_115_fechamentos_empresa_data.sql");
const DOWN = ler("database/rollback/20261103_115_fechamentos_empresa_data_down.sql");
const PRE = ler("database/checks/20261103_115_precheck.sql");
const POST = ler("database/checks/20261103_115_postcheck.sql");
/** O precheck abre a própria transação READ ONLY; dentro da transação do teste roda só o corpo. */
const preNaTransacao = PRE.split(/\r?\n/).filter((l) => !/^\s*(BEGIN TRANSACTION READ ONLY|ROLLBACK);\s*$/i.test(l)).join("\n");
const NOME = "fechamentos_115_empresa_data_idx";
const N054 = "fechamentos_054_empresa_idx";
const DEF054 = `CREATE INDEX ${N054} ON public.fechamentos USING btree (empresa_id) WHERE (empresa_id IS NOT NULL)`;

async function tentar(db: Client, sql: string) {
  await db.query("SAVEPOINT tentativa");
  try {
    await db.query(sql);
    return "passou";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    await db.query("ROLLBACK TO SAVEPOINT tentativa");
  }
}

const definicao = async (db: Client, nome = NOME) =>
  (await db.query<{ d: string | null }>(
    `SELECT (SELECT CASE WHEN c.relkind = 'i' THEN pg_get_indexdef(c.oid) ELSE 'relkind ' || c.relkind::text END FROM pg_class c WHERE c.oid = to_regclass('public.${nome}')) AS d`,
  )).rows[0].d;
const quantos = async (db: Client, nome = NOME) =>
  Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM pg_class WHERE relname = '${nome}'`)).rows[0].n);

test("115: índice (empresa_id, data_evento) em fechamentos — subida, guarda, checks, down e limites", { timeout: 120_000 }, async (t) => {
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    const ident = (await db.query<{ db: string; port: number }>("SELECT current_database() AS db, inet_server_port() AS port")).rows[0];
    assert.equal(ident.db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.port), portaDescartavel());
    assert.equal(await quantos(db), 0, "o modelo 111 não tem a 115");
    assert.equal(await definicao(db, N054), DEF054, "o modelo 111 tem o 054 da 054");

    await t.test("limites declarados na subida e no down; só um índice btree comum", () => {
      for (const sql of [UP, DOWN]) {
        assert.match(sql, /^BEGIN;$/m);
        assert.match(sql, /SET LOCAL lock_timeout = '5s';/);
        assert.match(sql, /SET LOCAL statement_timeout = '60s';/);
        assert.match(sql, /SET LOCAL search_path = public, pg_catalog;/);
        assert.match(sql, /^COMMIT;$/m);
      }
      const semComentarios = UP.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join("\n");
      assert.doesNotMatch(semComentarios, /\b(CONCURRENTLY|UNIQUE|ALTER TABLE|INSERT|UPDATE|DELETE)\b/i);
      const cria115 = semComentarios.indexOf("CREATE INDEX IF NOT EXISTS fechamentos_115_empresa_data_idx ON public.fechamentos (empresa_id, data_evento);");
      const remove054 = semComentarios.indexOf("DROP INDEX IF EXISTS public.fechamentos_054_empresa_idx;");
      assert.ok(cria115 > 0 && remove054 > cria115, "o 054 só sai depois que o 115 existe");
      const semComentariosDown = DOWN.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join("\n");
      const cria054 = semComentariosDown.indexOf("CREATE INDEX IF NOT EXISTS fechamentos_054_empresa_idx ON public.fechamentos (empresa_id) WHERE empresa_id IS NOT NULL;");
      const remove115 = semComentariosDown.indexOf("DROP INDEX IF EXISTS public.fechamentos_115_empresa_data_idx;");
      assert.ok(cria054 > 0 && remove115 > cria054, "o down recria o 054 antes de tirar o 115");
      // A definição recriada é a da própria 054.
      assert.match(ler("database/migrations/20260928_054_empresa_id_clientes_fechamentos.sql"), /CREATE INDEX fechamentos_054_empresa_idx ON public\.fechamentos \(empresa_id\) WHERE empresa_id IS NOT NULL;/);
    });

    await t.test("precheck → subida → pós-check → reaplicação neutra → down → down neutro → nova subida", async () => {
      await db.query(PRE);
      await db.query("BEGIN");
      try {
        await db.query(semTransacaoExplicita(UP));
        await db.query(POST);
        const esperado = `CREATE INDEX ${NOME} ON public.fechamentos USING btree (empresa_id, data_evento)`;
        assert.equal(await definicao(db), esperado);
        assert.equal(await quantos(db, N054), 0, "a subida remove o 054");
        await db.query(semTransacaoExplicita(UP));
        assert.equal(await quantos(db), 1, "reaplicação não cria outro objeto");
        assert.equal(await definicao(db), esperado);
        assert.equal(await quantos(db, N054), 0);
        await db.query(preNaTransacao);
        await db.query(semTransacaoExplicita(DOWN));
        assert.equal(await quantos(db), 0);
        assert.equal(await definicao(db, N054), DEF054, "o down recria o 054 idêntico ao da 054");
        await db.query(semTransacaoExplicita(DOWN));
        assert.equal(await definicao(db, N054), DEF054, "down de novo é neutro");
        assert.match(await tentar(db, POST), /postcheck 115: .* ausente ou com outra definição/);
        await db.query(semTransacaoExplicita(UP));
        await db.query(POST);
        // Pós-check recusa o 054 de volta ao lado do 115.
        await db.query(`CREATE INDEX ${N054} ON public.fechamentos (empresa_id) WHERE empresa_id IS NOT NULL`);
        assert.match(await tentar(db, POST), /postcheck 115: fechamentos_054_empresa_idx ainda existe/);
      } finally {
        await db.query("ROLLBACK");
      }
      assert.equal(await quantos(db), 0, "tudo desfeito");
      assert.equal(await definicao(db, N054), DEF054, "054 intacto");
    });

    await t.test("054 homônimo divergente: subida, precheck e down recusam sem alterar nada", async () => {
      const divergentes = [
        `CREATE INDEX ${N054} ON public.fechamentos (empresa_id)`,
        `CREATE INDEX ${N054} ON public.fechamentos (empresa_id DESC) WHERE empresa_id IS NOT NULL`,
        `CREATE INDEX ${N054} ON public.fechamentos (empresa_id, id) WHERE empresa_id IS NOT NULL`,
        `CREATE UNIQUE INDEX ${N054} ON public.fechamentos (empresa_id, id) WHERE empresa_id IS NOT NULL`,
        `CREATE INDEX ${N054} ON public.fechamentos (empresa_id) WHERE empresa_id IS NOT NULL AND status <> 'CANCELADO'`,
        `CREATE INDEX ${N054} ON public.clientes (empresa_id) WHERE empresa_id IS NOT NULL`,
        `CREATE TABLE public.${N054} (empresa_id uuid)`,
      ];
      for (const ddl of divergentes) {
        await db.query("BEGIN");
        try {
          await db.query(`DROP INDEX public.${N054}`);
          await db.query(ddl);
          const antes = await definicao(db, N054);
          assert.match(await tentar(db, semTransacaoExplicita(UP)), /115: fechamentos_054_empresa_idx existe com outra definição/, ddl);
          assert.match(await tentar(db, preNaTransacao), /precheck 115: fechamentos_054_empresa_idx existe com outra definição/, ddl);
          assert.match(await tentar(db, semTransacaoExplicita(DOWN)), /115 down: fechamentos_054_empresa_idx existe com outra definição/, ddl);
          assert.equal(await quantos(db), 0, ddl);
          assert.equal(await definicao(db, N054), antes, ddl);
        } finally {
          await db.query("ROLLBACK");
        }
      }
      assert.equal(await definicao(db, N054), DEF054);
    });

    await t.test("homônimo divergente: subida, precheck, pós-check e down recusam sem alterar nada", async () => {
      const divergentes = [
        `CREATE INDEX ${NOME} ON public.fechamentos (data_evento, empresa_id)`,
        `CREATE INDEX ${NOME} ON public.fechamentos (empresa_id, data_evento DESC)`,
        `CREATE INDEX ${NOME} ON public.fechamentos (empresa_id NULLS FIRST, data_evento)`,
        `CREATE UNIQUE INDEX ${NOME} ON public.fechamentos (empresa_id, data_evento, id)`,
        `CREATE INDEX ${NOME} ON public.fechamentos (empresa_id, data_evento) WHERE status <> 'CANCELADO'`,
        `CREATE INDEX ${NOME} ON public.fechamentos (empresa_id, data_evento) INCLUDE (id)`,
        `CREATE INDEX ${NOME} ON public.fechamentos (empresa_id, (data_evento + 0))`,
        `CREATE INDEX ${NOME} ON public.fechamentos (empresa_id)`,
        `CREATE INDEX ${NOME} ON public.fechamentos USING hash (empresa_id)`,
        `CREATE INDEX ${NOME} ON public.clientes (empresa_id, nome_completo)`,
        `CREATE TABLE public.${NOME} (empresa_id uuid, data_evento date)`,
      ];
      for (const ddl of divergentes) {
        await db.query("BEGIN");
        try {
          await db.query(ddl);
          const antes = await definicao(db);
          assert.match(await tentar(db, semTransacaoExplicita(UP)), /115: existe objeto fechamentos_115_empresa_data_idx com outra definição/, ddl);
          assert.match(await tentar(db, preNaTransacao), /precheck 115: .* outra definição/, ddl);
          assert.match(await tentar(db, POST), /postcheck 115: .* ausente ou com outra definição/, ddl);
          assert.match(await tentar(db, semTransacaoExplicita(DOWN)), /115 down: .* não é o índice da 115/, ddl);
          assert.equal(await quantos(db), 1, ddl);
          assert.equal(await definicao(db), antes, ddl);
        } finally {
          await db.query("ROLLBACK");
        }
      }
      assert.equal(await quantos(db), 0);
    });

    await t.test("escrita aberta em fechamentos: a subida desiste pelo lock_timeout (5 s) e nada fica criado", async () => {
      const escritor = await conectarDescartavel({ travar: false }) as unknown as Client;
      try {
        await escritor.query("BEGIN");
        await escritor.query("LOCK TABLE public.fechamentos IN ROW EXCLUSIVE MODE");
        const inicio = Date.now();
        const r = await db.query(UP).then(() => "passou", (e: Error) => e.message);
        const ms = Date.now() - inicio;
        await db.query("ROLLBACK").catch(() => undefined);
        assert.match(r, /lock timeout|tempo de espera|bloqueio/i);
        assert.ok(ms >= 4_500 && ms < 30_000, `desistiu em ${ms} ms`);
      } finally {
        await escritor.query("ROLLBACK").catch(() => undefined);
        await encerrarDescartavel(escritor as never, false);
      }
      assert.equal(await quantos(db), 0);
    });
  } finally {
    await encerrarDescartavel(client);
  }
});
