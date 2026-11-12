import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { empresaFundador, hojeBanco, inserir, somar, usuarioSintetico } from "./renovacao-109-apoio.postgres.test-apoio.ts";

/**
 * 30/10/2026 — APLICADOR REAL da 109 (scripts/migration-109-staging.cjs) no PostgreSQL descartável, no modelo 106 (como o
 * staging de hoje: 075 íntegra, sem a 109), com uma renovação PENDENTE real na tabela. Única substituição: o cliente do
 * aplicador conecta ao cluster descartável e responde à consulta de identidade como o banco de staging. Toda recusa compara a
 * IMPRESSÃO do schema public (antes = depois). Casos:
 *   1. conferência só leitura → PRONTA (capacidade 075, precheck PASS, contagens), nada muda;
 *   2. sessão do cron da renovação ativa (application_name kidmais-renovacao-cron) → RENOVACAO_EM_EXECUCAO, nada escrito;
 *   3. retrato da 075 com deriva (gatilho desabilitado; corpo da guarda trocado) → RETRATO_DIVERGENTE_109 com o nome;
 *   4. papel NÃO superusuário dono da tabela, com exatamente o mínimo (USAGE/CREATE em public): sem ser dono e sem CREATE,
 *      cada falta ISOLADA gera a recusa nomeada; com o mínimo, APLICA (contagens por estado iguais, comSubstituto 0);
 *   5. depois: conferência JA_APLICADA (capacidade 109 no catálogo REAL, como o dono e como admin), segunda tentativa
 *      recusada pelo marcador; deriva da 109 (função trocada, índice removido) → RECUSARIA; restaurada → JA_APLICADA;
 *   6. down (só no descartável, sem histórico) volta à impressão inicial;
 *   7. falha REAL: outra sessão segura assinatura_renovacoes (ROW EXCLUSIVE) → o LOCK ACCESS EXCLUSIVE da 109 estoura o
 *      lock_timeout → NAO_COMMITADA, nada criado; marcador renomeado → retomada aplica; down.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
type Resultado = { resultado: string; motivo?: string; mensagem?: string; falha?: { etapa: string; mensagem: string }; etapas?: string[];
  estado?: Record<string, unknown>; checks?: Record<string, string>; commits?: Record<string, string>; commitadas?: string[]; marcador?: string;
  contagens?: { total: number; porEstado: Record<string, number>; comSubstituto?: number };
  contagensAntes?: { porEstado: Record<string, number> }; contagensDepois?: { porEstado: Record<string, number>; comSubstituto?: number } };
type Aplicador = { SQL_IDENTIDADE: string; conferir(o: unknown): Promise<Resultado>; executar(o: unknown): Promise<Resultado> };
const stg = exigir(join(raiz, "scripts/migration-109-staging.cjs")) as Aplicador;
// Configuração FICTÍCIA: só satisfaz a trava de alvo; a URL nunca é usada (o cliente abaixo a ignora).
const ENV_STG = { RENDER: "true", RENDER_SERVICE_ID: "srv-daif418ae00c73e8k2gg", KIDMAIS_DEPLOY_ENV: "staging", DATABASE_SSL: "false",
  DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91" };
const IDENTIDADE = { db: "kidmais_staging_1z91", tls: false, servidor_privado: true };
const MINIMO = "kidmais_teste_minimo_109";
const sql = (p: string) => readFileSync(resolve(raiz, p), "utf8");
const DOWN109 = "database/rollback/20261029_109_renovacao_substituta_down.sql";

function clienteDescartavel(cfg: { papel?: string } = {}) {
  return class {
    c: Client | null = null;
    on() {}
    async connect() {
      this.c = await conectarDescartavel({ travar: false });
      this.c.on("error", () => undefined);
      if (cfg.papel) await this.c.query(`SET ROLE ${cfg.papel}`);
    }
    async query(q: string, p?: unknown[]) { return q === stg.SQL_IDENTIDADE ? { rows: [IDENTIDADE] } : this.c!.query(q, p); }
    async end() { if (this.c) await this.c.end(); }
  };
}

test("aplicador 109 real: sessão do cron, retrato divergente, papel dono não superusuário, capacidade no catálogo real, deriva, down, falha e retomada", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const dirs: string[] = [];
  const novoDir = () => { const d = mkdtempSync(join(tmpdir(), "aplicador-109-")); dirs.push(d); return d; };
  const BACKUP = "PITR 2026-10-30T09:00Z teste";
  const executar = (dir = novoDir(), papel?: string) => stg.executar({ env: ENV_STG, backup: BACKUP, dir, raiz, disco: () => {}, Client: clienteDescartavel({ papel }) });
  const conferir = (papel?: string) => stg.conferir({ env: ENV_STG, raiz, Client: clienteDescartavel({ papel }) });
  /** Impressão do schema public: relações, colunas, restrições, índices, gatilhos e funções (com donos). */
  const impressao = async () => (await c.query<{ h: string }>(`SELECT md5(concat_ws('|',
      (SELECT string_agg(concat_ws(':', cl.relname, cl.relkind, pg_get_userbyid(cl.relowner)), ',' ORDER BY cl.relname)
         FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE n.nspname = 'public'),
      (SELECT string_agg(concat_ws(':', cl.relname, a.attname, format_type(a.atttypid, a.atttypmod)), ',' ORDER BY cl.relname, a.attname)
         FROM pg_attribute a JOIN pg_class cl ON cl.oid = a.attrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped),
      (SELECT string_agg(concat_ws(':', conname, pg_get_constraintdef(k.oid)), ',' ORDER BY conname, k.oid)
         FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = 'public'),
      (SELECT string_agg(indexdef, ',' ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public'),
      (SELECT string_agg(concat_ws(':', tgname, tgenabled, pg_get_triggerdef(tg.oid)), ',' ORDER BY tgname, tg.tgrelid::regclass::text) FROM pg_trigger tg WHERE NOT tgisinternal),
      (SELECT string_agg(concat_ws(':', p.proname, md5(p.prosrc), pg_get_userbyid(p.proowner)), ',' ORDER BY p.proname, p.oid)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'))) AS h`)).rows[0].h;
  const instalada = async () => (await c.query<{ ok: boolean }>("SELECT to_regprocedure('public.kidmais_109_renovacao_guarda()') IS NOT NULL AS ok")).rows[0].ok;
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
    assert.equal(await instalada(), false, "modelo sem a 109");
    // Uma renovação PENDENTE real (raiz, pelo caminho do produto até o contrato Fundador): a 109 altera tabela COM dados.
    const usuario = (await c.query("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão 109', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id",
      usuarioSintetico())).rows[0].id as string;
    const e = await empresaFundador(c, usuario);
    const hoje = await hojeBanco(c);
    await inserir(c, e, { pdr: somar(hoje, 200), pv: somar(hoje, -100) });
    const porEstado = (await c.query<{ estado: string; n: number }>("SELECT estado, count(*)::int AS n FROM assinatura_renovacoes GROUP BY estado")).rows
      .reduce<Record<string, number>>((o, x) => ({ ...o, [x.estado]: x.n }), {});
    assert.ok((porEstado.PENDENTE ?? 0) >= 1);

    // 1. Conferência só leitura.
    const antes = await impressao();
    const conf = await conferir();
    assert.equal(conf.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(conf));
    assert.deepEqual(conf.checks, { "precheck 109": "PASS" }); assert.equal(conf.estado!.capacidade, "075");
    assert.deepEqual(conf.contagens!.porEstado, porEstado);
    assert.equal(await impressao(), antes);

    // 2. Sessão do cron da renovação ativa: recusa antes de qualquer escrita.
    const cron = await conectarDescartavel({ travar: false });
    try {
      await cron.query("SET application_name = 'kidmais-renovacao-cron'");
      await recusa(/RENOVACAO_EM_EXECUCAO 1/);
    } finally { await encerrarDescartavel(cron); }

    // 3. Retrato da 075 com deriva: cada uma isolada recusa com o nome; restaurada, volta a PRONTA.
    const guarda075 = (await c.query<{ d: string }>("SELECT pg_get_functiondef('public.kidmais_075_renovacao_guarda()'::regprocedure) AS d")).rows[0].d;
    for (const [derivar, restaurar, nome] of [
      ["ALTER TABLE public.assinatura_renovacoes DISABLE TRIGGER assinatura_renovacoes_075_guarda",
        "ALTER TABLE public.assinatura_renovacoes ENABLE TRIGGER assinatura_renovacoes_075_guarda", /gatilhos:(public\.)?assinatura_renovacoes_075_guarda:DIVERGE/],
      [guarda075.replace("RETURN NEW;", "RETURN NEW; -- deriva"), guarda075, /funcoes:(public\.)?kidmais_075_renovacao_guarda:DIVERGE/],
    ] as const) {
      await c.query(derivar);
      try { await recusa(new RegExp("RETRATO_DIVERGENTE_109 .*" + nome.source)); } finally { await c.query(restaurar); }
      assert.equal((await conferir()).resultado, "PRONTA_PARA_APLICAR", "restaurado: " + derivar.slice(0, 60));
    }
    assert.equal(await impressao(), antes, "estado inicial restaurado");

    // 4. Papel não superusuário: sem ser dono e sem CREATE, recusa nomeada; dono com o mínimo, aplica.
    await c.query(`DROP ROLE IF EXISTS ${MINIMO}`);
    await c.query(`CREATE ROLE ${MINIMO} NOLOGIN NOSUPERUSER`);
    let dirMin = "";
    try {
      await c.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${MINIMO}`);
      await c.query(`GRANT SELECT ON assinatura_renovacoes TO ${MINIMO}`);
      await recusa(/SEM_PRIVILEGIO_109 DONO_RENOVACOES$/, MINIMO);
      await c.query(`ALTER TABLE assinatura_renovacoes OWNER TO ${MINIMO}`);
      const antesDono = await impressao();
      const pronta = await conferir(MINIMO);
      assert.equal(pronta.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(pronta)); assert.equal(pronta.estado!.papel_trocado, true);
      await c.query(`REVOKE CREATE ON SCHEMA public FROM ${MINIMO}`);
      try { await recusa(/SEM_PRIVILEGIO_109 CREATE$/, MINIMO); } finally { await c.query(`GRANT CREATE ON SCHEMA public TO ${MINIMO}`); }
      assert.equal(await impressao(), antesDono);
      dirMin = novoDir();
      const ap = await executar(dirMin, MINIMO);
      assert.equal(ap.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(ap));
      assert.deepEqual(ap.commits, { 109: "CONFIRMADO" }); assert.deepEqual(ap.etapas, ["precheck 109", "migration 109", "capacidade 109"]);
      assert.deepEqual(ap.contagensDepois!.porEstado, porEstado); assert.equal(ap.contagensDepois!.comSubstituto, 0);

      // 5. Capacidade 109 no catálogo real (como o dono e como admin) e marcador anti-repetição.
      const ja = await conferir(MINIMO);
      assert.equal(ja.resultado, "JA_APLICADA_CAPACIDADE_PASS", JSON.stringify(ja)); assert.deepEqual(ja.checks, { "capacidade 109": "PASS" });
      assert.equal((await conferir()).resultado, "JA_APLICADA_CAPACIDADE_PASS");
      await assert.rejects(executar(dirMin, MINIMO), /TENTATIVA_ANTERIOR_REVISAR/);
      // Com a 109 completa, a sessão do cron NÃO impede a conferência (o cron novo convive com a 109).
      const cron2 = await conectarDescartavel({ travar: false });
      try { await cron2.query("SET application_name = 'kidmais-renovacao-cron'"); assert.equal((await conferir()).resultado, "JA_APLICADA_CAPACIDADE_PASS"); }
      finally { await encerrarDescartavel(cron2); }
      // Deriva da 109: cada uma isolada recusa pela capacidade; restaurada, volta a passar.
      const guarda109 = (await c.query<{ d: string }>("SELECT pg_get_functiondef('public.kidmais_109_renovacao_guarda()'::regprocedure) AS d")).rows[0].d;
      for (const [derivar, restaurar, nome] of [
        [guarda109.replace("RETURN NEW;", "RETURN NEW; -- deriva"), guarda109, /funcoes:(public\.)?kidmais_109_renovacao_guarda:DIVERGE/],
        ["DROP INDEX public.assinatura_renovacoes_109_vigente_uq",
          "CREATE UNIQUE INDEX assinatura_renovacoes_109_vigente_uq ON public.assinatura_renovacoes (contratacao_id) WHERE estado <> 'SUBSTITUIDA'", /indices:(public\.)?assinatura_renovacoes_109_vigente_uq:FALTA/],
      ] as const) {
        await c.query(`SET ROLE ${MINIMO}`); await c.query(derivar); await c.query("RESET ROLE");
        try {
          const d = await conferir();
          assert.equal(d.resultado, "RECUSARIA", derivar.slice(0, 60) + JSON.stringify(d)); assert.match(d.motivo!, new RegExp("RETRATO_DIVERGENTE_109 .*" + nome.source));
        } finally { await c.query(`SET ROLE ${MINIMO}`); await c.query(restaurar); await c.query("RESET ROLE"); }
        assert.equal((await conferir()).resultado, "JA_APLICADA_CAPACIDADE_PASS", "restaurado: " + derivar.slice(0, 60));
      }

      // 6. Down (só no descartável, sem histórico), pelo dono.
      await c.query(`SET ROLE ${MINIMO}`); await c.query(sql(DOWN109)); await c.query("RESET ROLE");
      assert.equal(await impressao(), antesDono, "down voltou ao estado do dono");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      await c.query("RESET ROLE").catch(() => undefined);
      await c.query(`REASSIGN OWNED BY ${MINIMO} TO "${admin}"`); await c.query(`DROP OWNED BY ${MINIMO}`); await c.query(`DROP ROLE ${MINIMO}`);
    }
    assert.equal(await instalada(), false, "down voltou ao estado inicial");
    assert.equal(await impressao(), antes, "impressão inicial depois do down");

    // 6b. Revisão do Astra (P3-1): prazo de execução ATIVO na própria transação de escrita. O DDL num banco pequeno termina em
    // menos de 1 ms (por isso um prazo minúsculo sozinho não prova nada): outra sessão segura a tabela e o corpo espera o
    // LOCK; com prazo de 1 s (< lock_timeout de 5 s do SQL), quem estoura é o statement_timeout (57014) antes do COMMIT →
    // NAO_COMMITADA, nada criado; o prazo de sessão não vaza para as leituras seguintes.
    const dirPrazo = novoDir();
    const segura = await conectarDescartavel({ travar: false });
    let prazo: Resultado;
    const inicioPrazo = Date.now();
    try {
      await segura.query("BEGIN"); await segura.query("LOCK TABLE assinatura_renovacoes IN ROW EXCLUSIVE MODE");
      prazo = await stg.executar({ env: ENV_STG, backup: BACKUP, dir: dirPrazo, raiz, disco: () => {}, Client: clienteDescartavel(), orcamento: "1s" });
    } finally { await segura.query("ROLLBACK").catch(() => undefined); await encerrarDescartavel(segura); }
    assert.ok(Date.now() - inicioPrazo < 4500, "parou pelo prazo de 1 s, antes do lock_timeout de 5 s");
    assert.equal(prazo.resultado, "FALHA", JSON.stringify(prazo));
    assert.deepEqual(prazo.commits, { 109: "NAO_COMMITADA" }); assert.equal(prazo.falha!.etapa, "migration 109");
    assert.match(prazo.falha!.mensagem, /statement timeout/);
    assert.equal(await instalada(), false, "nada criado pelo estouro do prazo");
    assert.equal(await impressao(), antes);
    assert.equal((await conferir()).resultado, "PRONTA_PARA_APLICAR");

    // 7. Falha real: outra sessão (que não é da renovação) segura assinatura_renovacoes; o LOCK da 109 estoura o lock_timeout.
    const trava = await conectarDescartavel({ travar: false });
    const dirFalha = novoDir();
    try {
      await trava.query("BEGIN");
      // ROW EXCLUSIVE deixa a leitura do catálogo, a capacidade, as contagens e o precheck passarem, mas conflita com o ACCESS EXCLUSIVE.
      await trava.query("LOCK TABLE assinatura_renovacoes IN ROW EXCLUSIVE MODE");
      const f = await executar(dirFalha);
      assert.equal(f.resultado, "FALHA", JSON.stringify(f));
      assert.deepEqual(f.commits, { 109: "NAO_COMMITADA" }); assert.equal(f.falha!.etapa, "migration 109");
      await trava.query("ROLLBACK");
    } finally { await trava.query("ROLLBACK").catch(() => undefined); await encerrarDescartavel(trava); }
    assert.equal(await instalada(), false, "nada criado");
    assert.equal(await impressao(), antes);
    await assert.rejects(executar(dirFalha), /TENTATIVA_ANTERIOR_REVISAR/);
    renameSync(join(dirFalha, "migration-109.json"), join(dirFalha, "migration-109.2026-10-30T09-00.json"));
    const retomada = await executar(dirFalha);
    assert.equal(retomada.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(retomada));
    assert.deepEqual(retomada.commits, { 109: "CONFIRMADO" });
    assert.equal((await conferir()).resultado, "JA_APLICADA_CAPACIDADE_PASS");
    await c.query(sql(DOWN109));
    assert.equal(await impressao(), antes, "limpo ao final");
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await encerrarDescartavel(c);
  }
});
