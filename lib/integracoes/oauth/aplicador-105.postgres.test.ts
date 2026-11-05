import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../../comercial/postgres-descartavel.ts";

/**
 * 27/10/2026 — APLICADOR REAL da 105 (scripts/migration-105-staging.cjs) no PostgreSQL descartável, nos modelos 103 (o
 * staging de hoje: 102/103 aplicadas, sem 104/105/106) e 104 (com a 104 da S-E). Única substituição: o cliente do
 * aplicador conecta ao cluster descartável e responde à consulta de identidade como o banco de staging. Toda recusa
 * compara a IMPRESSÃO do schema public (antes = depois). Casos:
 *   1. conferência só leitura → PRONTA, nada muda;
 *   2. 105 parcial (uma tabela mcp_* criada à mão) → RECUSARIA/FALHA sem escrever;
 *   3. papel NÃO superusuário com exatamente o mínimo (USAGE/CREATE em public, REFERENCES em usuarios_administrativos e
 *      empresas): cada privilégio retirado ISOLADAMENTE gera a recusa nomeada dele; com o mínimo, APLICA;
 *   4. depois da aplicação: conferência JA_APLICADA com a integridade PASS no catálogo REAL (prova as contagens do SQL
 *      de integridade) e segunda tentativa recusada pelo marcador;
 *   5. deriva: corpo da função trocado, um índice removido ou o gatilho desabilitado → RECUSARIA (INTEGRIDADE_105 false);
 *      restaurado → JA_APLICADA;
 *   6. down (só no descartável) volta à impressão inicial;
 *   7. falha REAL: outra sessão segura empresas (ACCESS EXCLUSIVE) → a FK da 105 estoura o lock_timeout → NAO_COMMITADA,
 *      nada criado; marcador renomeado → retomada aplica.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const exigir = createRequire(import.meta.url);
type Resultado = { resultado: string; motivo?: string; mensagem?: string; falha?: { etapa: string; mensagem: string }; etapas?: string[];
  estado?: Record<string, unknown>; checks?: Record<string, string>; commits?: Record<string, string>; commitadas?: string[]; marcador?: string };
type Aplicador = { SQL_IDENTIDADE: string; conferir(o: unknown): Promise<Resultado>; executar(o: unknown): Promise<Resultado> };
const stg = exigir(join(raiz, "scripts/migration-105-staging.cjs")) as Aplicador;
// Configuração FICTÍCIA: só satisfaz a trava de alvo; a URL nunca é usada (o cliente abaixo a ignora).
const ENV_STG = { RENDER: "true", RENDER_SERVICE_ID: "srv-daif418ae00c73e8k2gg", KIDMAIS_DEPLOY_ENV: "staging", DATABASE_SSL: "false",
  DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91" };
const IDENTIDADE = { db: "kidmais_staging_1z91", tls: false, servidor_privado: true };
const MINIMO = "kidmais_teste_minimo_105";
const sql = (p: string) => readFileSync(resolve(raiz, p), "utf8");
const M105 = "database/migrations/20261027_105_mcp_assinaturas.sql";
const DOWN105 = "database/rollback/20261027_105_mcp_assinaturas_down.sql";

function clienteDescartavel(cfg: { papel?: string } = {}) {
  return class {
    c: Client | null = null;
    on() {}
    async connect() {
      this.c = await conectarDescartavel({ travar: false });
      this.c.on("error", () => undefined);
      if (cfg.papel) await this.c.query(`SET ROLE ${cfg.papel}`);
    }
    async query(q: string) { return q === stg.SQL_IDENTIDADE ? { rows: [IDENTIDADE] } : this.c!.query(q); }
    async end() { if (this.c) await this.c.end(); }
  };
}

test("aplicador 105 real: recusas nomeadas, papel mínimo não superusuário, integridade no catálogo real, deriva, down, falha e retomada", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const dirs: string[] = [];
  const novoDir = () => { const d = mkdtempSync(join(tmpdir(), "aplicador-105-")); dirs.push(d); return d; };
  const BACKUP = "PITR 2026-10-27T21:00Z teste";
  const executar = (dir = novoDir(), papel?: string) => stg.executar({ env: ENV_STG, backup: BACKUP, dir, raiz, disco: () => {}, Client: clienteDescartavel({ papel }) });
  const conferir = (papel?: string) => stg.conferir({ env: ENV_STG, raiz, Client: clienteDescartavel({ papel }) });
  /** Impressão do schema public: relações, colunas, restrições, gatilhos e funções (com donos). */
  const impressao = async () => (await c.query<{ h: string }>(`SELECT md5(concat_ws('|',
      (SELECT string_agg(concat_ws(':', cl.relname, cl.relkind, pg_get_userbyid(cl.relowner)), ',' ORDER BY cl.relname)
         FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE n.nspname = 'public'),
      (SELECT string_agg(concat_ws(':', cl.relname, a.attname, format_type(a.atttypid, a.atttypmod)), ',' ORDER BY cl.relname, a.attname)
         FROM pg_attribute a JOIN pg_class cl ON cl.oid = a.attrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped),
      (SELECT string_agg(concat_ws(':', conname, pg_get_constraintdef(k.oid)), ',' ORDER BY conname, k.oid)
         FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = 'public'),
      (SELECT string_agg(concat_ws(':', tgname, pg_get_triggerdef(tg.oid)), ',' ORDER BY tgname) FROM pg_trigger tg WHERE NOT tgisinternal),
      (SELECT string_agg(concat_ws(':', p.proname, md5(p.prosrc), pg_get_userbyid(p.proowner)), ',' ORDER BY p.proname, p.oid)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'))) AS h`)).rows[0].h;
  const instalada = async () => (await c.query<{ ok: boolean }>("SELECT to_regclass('public.mcp_oauth_concessoes') IS NOT NULL AS ok")).rows[0].ok;
  /** Recusa: conferência RECUSARIA com o motivo e aplicação FALHA sem commit; a impressão não muda. */
  const recusa = async (motivo: RegExp, papel?: string) => {
    const antes = await impressao();
    const r = await conferir(papel);
    assert.equal(r.resultado, "RECUSARIA", JSON.stringify(r)); assert.match(r.motivo!, motivo);
    const e = await executar(novoDir(), papel);
    assert.equal(e.resultado, "FALHA", JSON.stringify(e)); assert.match(e.falha!.mensagem, motivo); assert.deepEqual(e.commitadas, []);
    assert.equal(await impressao(), antes, "nada mudou: " + motivo.source);
  };
  const admin = (await c.query<{ u: string }>("SELECT current_user AS u")).rows[0].u.replace(/"/g, '""');
  try {
    assert.equal(await instalada(), false, "modelo sem a 105");
    // 1. Conferência só leitura.
    const antes = await impressao();
    const conf = await conferir();
    assert.equal(conf.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(conf));
    assert.deepEqual(conf.checks, { "precheck 105": "PASS" });
    assert.equal(await impressao(), antes);

    // 2. 105 parcial.
    await c.query("CREATE TABLE public.mcp_oauth_clientes (client_id text PRIMARY KEY)");
    try { await recusa(/APLICACAO_PARCIAL_105/); }
    finally { await c.query("DROP TABLE public.mcp_oauth_clientes"); }
    assert.equal(await impressao(), antes, "estado inicial restaurado");

    // 3. Papel mínimo não superusuário; cada privilégio retirado isoladamente.
    await c.query(`DROP ROLE IF EXISTS ${MINIMO}`);
    await c.query(`CREATE ROLE ${MINIMO} NOLOGIN NOSUPERUSER`);
    try {
      await c.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${MINIMO}`);
      await c.query(`GRANT REFERENCES ON usuarios_administrativos, empresas TO ${MINIMO}`);
      const pronta = await conferir(MINIMO);
      assert.equal(pronta.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(pronta));
      assert.equal(pronta.estado!.papel_trocado, true);
      for (const [revogar, conceder, motivo] of [
        [`REVOKE CREATE ON SCHEMA public FROM ${MINIMO}`, `GRANT CREATE ON SCHEMA public TO ${MINIMO}`, /SEM_PRIVILEGIO_105 CREATE$/],
        [`REVOKE REFERENCES ON usuarios_administrativos FROM ${MINIMO}`, `GRANT REFERENCES ON usuarios_administrativos TO ${MINIMO}`, /SEM_PRIVILEGIO_105 REFERENCES$/],
        [`REVOKE REFERENCES ON empresas FROM ${MINIMO}`, `GRANT REFERENCES ON empresas TO ${MINIMO}`, /SEM_PRIVILEGIO_105 REFERENCES$/],
      ] as const) {
        await c.query(revogar);
        try { await recusa(motivo, MINIMO); } finally { await c.query(conceder); }
      }
      // Com o mínimo, o papel não superusuário aplica.
      const dirMin = novoDir();
      const ap = await executar(dirMin, MINIMO);
      assert.equal(ap.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(ap));
      assert.deepEqual(ap.commits, { 105: "CONFIRMADO" }); assert.deepEqual(ap.etapas, ["precheck 105", "migration 105", "integridade 105"]);

      // 4. Integridade no catálogo real (como o próprio dono e como admin) e marcador anti-repetição.
      const ja = await conferir(MINIMO);
      assert.equal(ja.resultado, "JA_APLICADA_INTEGRIDADE_PASS", JSON.stringify(ja));
      assert.deepEqual(ja.checks, { "integridade 105": "PASS" });
      assert.equal((await conferir()).resultado, "JA_APLICADA_INTEGRIDADE_PASS");
      await assert.rejects(executar(dirMin, MINIMO), /TENTATIVA_ANTERIOR_REVISAR/);

      // 5. Deriva: cada uma isolada recusa pela integridade; restaurada, volta a passar.
      const corpo = /AS \$f\$([\s\S]*?)\$f\$;/.exec(sql(M105))![1];
      for (const [derivar, restaurar] of [
        [`CREATE OR REPLACE FUNCTION public.mcp_oauth_concessao_revogacao_imutavel() RETURNS trigger LANGUAGE plpgsql AS $f$BEGIN RETURN NEW; END$f$`,
          `CREATE OR REPLACE FUNCTION public.mcp_oauth_concessao_revogacao_imutavel() RETURNS trigger LANGUAGE plpgsql AS $f$${corpo}$f$`],
        ["DROP INDEX public.mcp_oauth_tokens_expira_idx", "CREATE INDEX mcp_oauth_tokens_expira_idx ON public.mcp_oauth_tokens (expira_em)"],
        ["ALTER TABLE public.mcp_oauth_concessoes DISABLE TRIGGER mcp_oauth_concessoes_revogacao_imutavel",
          "ALTER TABLE public.mcp_oauth_concessoes ENABLE TRIGGER mcp_oauth_concessoes_revogacao_imutavel"],
        ["ALTER TABLE public.mcp_auditoria ADD COLUMN extra text", "ALTER TABLE public.mcp_auditoria DROP COLUMN extra"],
      ] as const) {
        await c.query(`SET ROLE ${MINIMO}`); await c.query(derivar); await c.query("RESET ROLE");
        try {
          const d = await conferir();
          assert.equal(d.resultado, "RECUSARIA", derivar + JSON.stringify(d)); assert.match(d.motivo!, /INTEGRIDADE_105 false/);
        } finally { await c.query(`SET ROLE ${MINIMO}`); await c.query(restaurar); await c.query("RESET ROLE"); }
        assert.equal((await conferir()).resultado, "JA_APLICADA_INTEGRIDADE_PASS", "restaurado: " + derivar);
      }

      // 6. Down (só no descartável).
      await c.query(`SET ROLE ${MINIMO}`); await c.query(sql(DOWN105)); await c.query("RESET ROLE");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      await c.query("RESET ROLE").catch(() => undefined);
      await c.query(`REASSIGN OWNED BY ${MINIMO} TO "${admin}"`); await c.query(`DROP OWNED BY ${MINIMO}`); await c.query(`DROP ROLE ${MINIMO}`);
    }
    assert.equal(await instalada(), false, "down voltou ao estado inicial");
    assert.equal(await impressao(), antes, "impressão inicial depois do down");

    // 7. Falha real: outra sessão segura empresas; a FK da 105 estoura o lock_timeout de 5 s dentro da transação.
    const trava = await conectarDescartavel({ travar: false });
    const dirFalha = novoDir();
    try {
      await trava.query("BEGIN");
      // ROW EXCLUSIVE deixa a leitura do catálogo e o precheck passarem, mas conflita com o SHARE ROW EXCLUSIVE da FK.
      await trava.query("LOCK TABLE empresas IN ROW EXCLUSIVE MODE");
      const f = await executar(dirFalha);
      assert.equal(f.resultado, "FALHA", JSON.stringify(f));
      assert.deepEqual(f.commits, { 105: "NAO_COMMITADA" }); assert.equal(f.falha!.etapa, "migration 105");
      await trava.query("ROLLBACK");
    } finally { await trava.query("ROLLBACK").catch(() => undefined); await encerrarDescartavel(trava); }
    assert.equal(await instalada(), false, "nada criado");
    assert.equal(await impressao(), antes);
    await assert.rejects(executar(dirFalha), /TENTATIVA_ANTERIOR_REVISAR/);
    renameSync(join(dirFalha, "migration-105.json"), join(dirFalha, "migration-105.2026-10-27T21-00.json"));
    const retomada = await executar(dirFalha);
    assert.equal(retomada.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(retomada));
    assert.deepEqual(retomada.commits, { 105: "CONFIRMADO" });
    assert.equal((await conferir()).resultado, "JA_APLICADA_INTEGRIDADE_PASS");
    await c.query(sql(DOWN105));
    assert.equal(await impressao(), antes, "limpo ao final");
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await encerrarDescartavel(c);
  }
});
