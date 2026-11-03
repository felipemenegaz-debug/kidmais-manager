import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";

/**
 * 01/11/2026 — APLICADOR REAL da 112 (scripts/migration-112-staging.cjs) no PostgreSQL descartável, no modelo 109 (staging
 * de hoje sem a 112), com clientes PF reais, um deles MESCLADO com o registro em mesclagens_clientes. Única substituição: o
 * cliente do aplicador conecta ao cluster descartável e responde à consulta de identidade como o banco de staging. Toda
 * recusa compara a IMPRESSÃO do schema public (antes = depois). Casos:
 *   1. conferência só leitura → PRONTA (precheck PASS, contagens por status), nada muda;
 *   2. aplicação parcial simulada (uma função da 112 criada à mão) → APLICACAO_PARCIAL_112 com o grupo, nada escrito;
 *   3. papel NÃO superusuário: sem ser dono, dono só de clientes e sem CREATE, cada falta gera a recusa nomeada; dono das
 *      duas tabelas com o mínimo, APLICA (preservação e postcheck na transação; contagens por status iguais; todas PF);
 *   4. depois: conferência JA_APLICADA (como o dono e como admin), segunda tentativa recusada pelo marcador; deriva (gatilho
 *      desabilitado; CHECK removido) → RECUSARIA pelo postcheck / parcial; restaurada → JA_APLICADA; down volta à impressão;
 *   5. controle positivo da prova de preservação: uma linha escrita na própria transação é contada;
 *   6. falha REAL: outra sessão segura clientes (ROW EXCLUSIVE) → o LOCK ACCESS EXCLUSIVE da 112 estoura o lock_timeout →
 *      NAO_COMMITADA, nada criado; marcador renomeado → retomada aplica; down.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
type Resultado = { resultado: string; motivo?: string; mensagem?: string; falha?: { etapa: string; mensagem: string }; etapas?: string[];
  estado?: Record<string, unknown>; checks?: Record<string, string>; commits?: Record<string, string>; commitadas?: string[]; marcador?: string;
  contagens?: { total: number; porStatus: Record<string, number>; porTipo?: Record<string, number> };
  contagensAntes?: { porStatus: Record<string, number> }; contagensDepois?: { porStatus: Record<string, number>; porTipo?: Record<string, number> } };
type Aplicador = { SQL_IDENTIDADE: string; conferir(o: unknown): Promise<Resultado>; executar(o: unknown): Promise<Resultado> };
const stg = exigir(join(raiz, "scripts/migration-112-staging.cjs")) as Aplicador;
const { SQL_PRESERVACAO } = exigir(join(raiz, "scripts/migration-112-comum.cjs")) as { SQL_PRESERVACAO: string };
// Configuração FICTÍCIA: só satisfaz a trava de alvo; a URL nunca é usada (o cliente abaixo a ignora).
const ENV_STG = { RENDER: "true", RENDER_SERVICE_ID: "srv-daif418ae00c73e8k2gg", KIDMAIS_DEPLOY_ENV: "staging", DATABASE_SSL: "false",
  DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91" };
const IDENTIDADE = { db: "kidmais_staging_1z91", tls: false, servidor_privado: true };
const MINIMO = "kidmais_teste_minimo_112";
const DOWN112 = readFileSync(resolve(raiz, "database/rollback/20261101_112_clientes_pessoa_juridica_down.sql"), "utf8");

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

test("aplicador 112 real: parcial, papel dono não superusuário, preservação, postcheck no catálogo real, deriva, down, falha e retomada", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const dirs: string[] = [];
  const novoDir = () => { const d = mkdtempSync(join(tmpdir(), "aplicador-112-")); dirs.push(d); return d; };
  const BACKUP = "PITR 2026-11-01T09:00Z teste";
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
  /** Linhas de clientes e de mesclagens (sem colunas novas): o retrato que a 112 não pode mudar. */
  const dados = async () => (await c.query<{ h: string }>(`SELECT md5(concat_ws('|',
      (SELECT string_agg(concat_ws(':', id, empresa_id, nome_completo, cpf, status, cliente_principal_id, xmin), ',' ORDER BY id) FROM clientes),
      (SELECT string_agg(concat_ws(':', id, cliente_principal_id, cliente_secundario_id, xmin), ',' ORDER BY id) FROM mesclagens_clientes))) AS h`)).rows[0].h;
  const instalada = async () => (await c.query<{ ok: boolean }>("SELECT to_regclass('public.clientes_cnpj_empresa_canonico_uk') IS NOT NULL AS ok")).rows[0].ok;
  /** Recusa: conferência RECUSARIA com o motivo e aplicação FALHA sem commit; a impressão e os dados não mudam. */
  const recusa = async (motivo: RegExp, papel?: string) => {
    const antes = await impressao(), linhas = await dados();
    const r = await conferir(papel);
    assert.equal(r.resultado, "RECUSARIA", JSON.stringify(r)); assert.match(r.motivo!, motivo);
    const e = await executar(novoDir(), papel);
    assert.equal(e.resultado, "FALHA", JSON.stringify(e)); assert.match(e.falha!.mensagem, motivo); assert.deepEqual(e.commitadas, []);
    assert.equal(await impressao(), antes, "nada mudou: " + motivo.source); assert.equal(await dados(), linhas);
  };
  const admin = (await c.query<{ u: string }>("SELECT current_user AS u")).rows[0].u.replace(/"/g, '""');
  try {
    assert.equal(await instalada(), false, "modelo sem a 112");
    // Clientes PF reais, um MESCLADO no principal com o registro da mesclagem: a 112 altera tabela COM dados.
    const empresa = (await c.query("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet aplicador 112', 'PROVISIONAMENTO') RETURNING id",
      [`ap${randomBytes(4).toString("hex")}`])).rows[0].id as string;
    const pf = async (nome: string, cpf: string | null) => (await c.query("INSERT INTO clientes (empresa_id, nome_completo, cpf, telefone) VALUES ($1, $2, $3, '61987654321') RETURNING id",
      [empresa, nome, cpf])).rows[0].id as string;
    const principal = await pf("Paula Ramos", "52998224725");
    const secundario = await pf("Paula R.", null);
    await pf("Carla Dias", "11144477735");
    const usuario = (await c.query("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Op 112', $2, 'ADMINISTRATIVO', true) RETURNING id",
      [`op${randomBytes(4).toString("hex")}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`])).rows[0].id as string;
    await c.query("UPDATE clientes SET status = 'MESCLADO', cliente_principal_id = $2, mesclado_em = now() WHERE id = $1", [secundario, principal]);
    await c.query("INSERT INTO mesclagens_clientes (cliente_principal_id, cliente_secundario_id, motivo, executado_por_usuario_id) VALUES ($1, $2, 'Duplicado', $3)",
      [principal, secundario, usuario]);
    const porStatus = (await c.query<{ status: string; n: number }>("SELECT status::text AS status, count(*)::int AS n FROM clientes GROUP BY status")).rows
      .reduce<Record<string, number>>((o, x) => ({ ...o, [x.status]: x.n }), {});
    assert.ok((porStatus.MESCLADO ?? 0) >= 1);
    const linhasIniciais = await dados();

    // 1. Conferência só leitura.
    const antes = await impressao();
    const conf = await conferir();
    assert.equal(conf.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(conf));
    assert.deepEqual(conf.checks, { "precheck 112": "PASS" }); assert.equal(conf.estado!.objetos, 0);
    assert.deepEqual(conf.contagens!.porStatus, porStatus); assert.equal(conf.contagens!.porTipo, undefined);
    assert.equal(await impressao(), antes); assert.equal(await dados(), linhasIniciais);

    // 2. Aplicação parcial simulada: uma das funções da 112 já existe.
    await c.query("CREATE FUNCTION public.kidmais_112_cpf_valido(doc text) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'");
    try { await recusa(/APLICACAO_PARCIAL_112 .*funcoes 1\/3/); } finally { await c.query("DROP FUNCTION public.kidmais_112_cpf_valido(text)"); }
    assert.equal(await impressao(), antes, "estado inicial restaurado");

    // 3. Papel não superusuário: cada falta recusa com o nome; dono das duas tabelas com o mínimo, aplica.
    await c.query(`DROP ROLE IF EXISTS ${MINIMO}`);
    await c.query(`CREATE ROLE ${MINIMO} NOLOGIN NOSUPERUSER`);
    let dirMin = "";
    try {
      await c.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${MINIMO}`);
      await c.query(`GRANT SELECT ON clientes TO ${MINIMO}`);
      await recusa(/SEM_PRIVILEGIO_112 DONO_CLIENTES DONO_MESCLAGENS$/, MINIMO);
      await c.query(`ALTER TABLE clientes OWNER TO ${MINIMO}`);
      await recusa(/SEM_PRIVILEGIO_112 DONO_MESCLAGENS$/, MINIMO);
      await c.query(`ALTER TABLE mesclagens_clientes OWNER TO ${MINIMO}`);
      const antesDono = await impressao();
      const pronta = await conferir(MINIMO);
      assert.equal(pronta.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(pronta)); assert.equal(pronta.estado!.papel_trocado, true);
      await c.query(`REVOKE CREATE ON SCHEMA public FROM ${MINIMO}`);
      try { await recusa(/SEM_PRIVILEGIO_112 CREATE$/, MINIMO); } finally { await c.query(`GRANT CREATE ON SCHEMA public TO ${MINIMO}`); }
      assert.equal(await impressao(), antesDono);
      dirMin = novoDir();
      const ap = await executar(dirMin, MINIMO);
      assert.equal(ap.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(ap));
      assert.deepEqual(ap.commits, { 112: "CONFIRMADO" }); assert.deepEqual(ap.etapas, ["precheck 112", "migration 112", "postcheck 112"]);
      assert.deepEqual(ap.contagensDepois!.porStatus, porStatus);
      assert.deepEqual(ap.contagensDepois!.porTipo, { PF: Object.values(porStatus).reduce((a, b) => a + b, 0) });
      const m = JSON.parse(readFileSync(ap.marcador!, "utf8"));
      assert.deepEqual(m.etapas.find((e: { nome: string }) => e.nome === "migration 112").antesDoCommit, { preservacao: "PASS", "postcheck 112": "PASS" });
      // As linhas não foram reescritas (xmin incluído no retrato) e continuam PF sem dado de PJ.
      assert.equal(await dados(), linhasIniciais, "nenhuma linha reescrita");
      assert.equal((await c.query("SELECT count(*)::int AS n FROM clientes WHERE tipo_pessoa <> 'PF' OR cnpj IS NOT NULL OR razao_social IS NOT NULL")).rows[0].n, 0);

      // 4. Postcheck no catálogo real (como o dono e como admin) e marcador anti-repetição.
      const ja = await conferir(MINIMO);
      assert.equal(ja.resultado, "JA_APLICADA_POSTCHECK_PASS", JSON.stringify(ja)); assert.deepEqual(ja.checks, { "postcheck 112": "PASS" });
      assert.equal((await conferir()).resultado, "JA_APLICADA_POSTCHECK_PASS");
      await assert.rejects(executar(dirMin, MINIMO), /TENTATIVA_ANTERIOR_REVISAR/);
      // Deriva da 112: gatilho desabilitado (19 objetos, postcheck recusa) e CHECK removido (18 objetos, parcial).
      const checkDef = (await c.query<{ d: string }>("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'clientes_112_representante_nome'")).rows[0].d;
      for (const [derivar, restaurar, motivo] of [
        ["ALTER TABLE clientes DISABLE TRIGGER clientes_112_mesclagem_mesmo_tipo", "ALTER TABLE clientes ENABLE TRIGGER clientes_112_mesclagem_mesmo_tipo",
          /112 postcheck: gatilhos de mesclagem ausentes ou divergentes/],
        ["ALTER TABLE clientes DROP CONSTRAINT clientes_112_representante_nome", `ALTER TABLE clientes ADD CONSTRAINT clientes_112_representante_nome ${checkDef}`,
          /APLICACAO_PARCIAL_112 restricoes 6\/7$/],
      ] as const) {
        await c.query(`SET ROLE ${MINIMO}`); await c.query(derivar); await c.query("RESET ROLE");
        try {
          const d = await conferir();
          assert.equal(d.resultado, "RECUSARIA", derivar.slice(0, 60) + JSON.stringify(d)); assert.match(d.motivo!, motivo);
        } finally { await c.query(`SET ROLE ${MINIMO}`); await c.query(restaurar); await c.query("RESET ROLE"); }
        assert.equal((await conferir()).resultado, "JA_APLICADA_POSTCHECK_PASS", "restaurado: " + derivar.slice(0, 60));
      }

      // Down (só no descartável, sem PJ), pelo dono.
      await c.query(`SET ROLE ${MINIMO}`); await c.query(DOWN112); await c.query("RESET ROLE");
      assert.equal(await impressao(), antesDono, "down voltou ao estado do dono");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      await c.query("RESET ROLE").catch(() => undefined);
      await c.query(`REASSIGN OWNED BY ${MINIMO} TO "${admin}"`); await c.query(`DROP OWNED BY ${MINIMO}`); await c.query(`DROP ROLE ${MINIMO}`);
    }
    assert.equal(await instalada(), false, "down voltou ao estado inicial");
    assert.equal(await impressao(), antes, "impressão inicial depois do down");

    // 5. Controle positivo da prova de preservação: a mesma consulta conta uma linha escrita na própria transação.
    await c.query("BEGIN");
    try {
      assert.deepEqual((await c.query(SQL_PRESERVACAO)).rows[0], { clientes_escritos: 0, mesclagens_escritas: 0 });
      await c.query("UPDATE clientes SET telefone = telefone WHERE id = $1", [principal]);
      assert.deepEqual((await c.query(SQL_PRESERVACAO)).rows[0], { clientes_escritos: 1, mesclagens_escritas: 0 });
    } finally { await c.query("ROLLBACK"); }

    // 6. Falha real: outra sessão segura clientes; o LOCK da 112 estoura o lock_timeout de 5 s do SQL.
    const trava = await conectarDescartavel({ travar: false });
    const dirFalha = novoDir();
    try {
      await trava.query("BEGIN");
      // ROW EXCLUSIVE deixa passar o catálogo, as contagens e o precheck, mas conflita com o ACCESS EXCLUSIVE.
      await trava.query("LOCK TABLE clientes IN ROW EXCLUSIVE MODE");
      const inicio = Date.now();
      const f = await executar(dirFalha);
      assert.ok(Date.now() - inicio >= 4500, "esperou o lock_timeout");
      assert.equal(f.resultado, "FALHA", JSON.stringify(f));
      assert.deepEqual(f.commits, { 112: "NAO_COMMITADA" }); assert.equal(f.falha!.etapa, "migration 112");
      assert.match(f.falha!.mensagem, /lock timeout/);
      await trava.query("ROLLBACK");
    } finally { await trava.query("ROLLBACK").catch(() => undefined); await encerrarDescartavel(trava); }
    assert.equal(await instalada(), false, "nada criado");
    assert.equal(await impressao(), antes);
    await assert.rejects(executar(dirFalha), /TENTATIVA_ANTERIOR_REVISAR/);
    renameSync(join(dirFalha, "migration-112.json"), join(dirFalha, "migration-112.2026-11-01T09-00.json"));
    const retomada = await executar(dirFalha);
    assert.equal(retomada.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(retomada));
    assert.deepEqual(retomada.commits, { 112: "CONFIRMADO" });
    assert.equal((await conferir()).resultado, "JA_APLICADA_POSTCHECK_PASS");
    assert.equal(await dados(), linhasIniciais, "retomada também não reescreveu linhas");
    await c.query(DOWN112);
    assert.equal(await impressao(), antes, "limpo ao final");
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await encerrarDescartavel(c);
  }
});
