import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts";
import { abrirCarteira, creditarLote } from "./ledger.ts";
import { franquiasInstaladas, registrarPendenciaFranquia } from "./franquias.ts";

/**
 * 04/11/2026 — APLICADOR REAL da 116 (scripts/migration-116-staging.cjs) no PostgreSQL descartável, no modelo 112 (staging
 * de hoje sem a 116), com dados reais nas 4 tabelas que a 116 trava: carteira CONVITES, lote CORTESIA, notificação
 * LOTE_VENCENDO_30 e contratação CONFIRMADA. Única substituição: o cliente do aplicador conecta ao cluster descartável e
 * responde à consulta de identidade como o banco de staging. Toda recusa compara a IMPRESSÃO do schema public (antes =
 * depois) e o retrato das 4 tabelas (com xmin). Casos:
 *   1. conferência só leitura → PRONTA (precheck PASS, contagens de lotes e notificações), nada muda;
 *   2. aplicação parcial simulada (a função da 116 criada à mão) → APLICACAO_PARCIAL_116 com os grupos, nada escrito;
 *   3. papel NÃO superusuário: sem ser dono das notificações, sem REFERENCES e sem CREATE, cada falta recusada com o nome;
 *      com o mínimo (dono de ia_credito_notificacoes + REFERENCES nas 3 referenciadas + SELECT), APLICA (preservação e
 *      postcheck na transação; nenhuma linha das 4 tabelas reescrita);
 *   4. depois: o código da F1 enxerga a 116 e registra a pendência (intenção) — o postcheck a aceita como legítima;
 *      conferência JA_APLICADA (como o dono e como admin); com a 116 presente, SELECT nas 2 tabelas novas e plpgsql revogados um a um → recusa pelo nome; segunda tentativa recusada pelo marcador; deriva (gatilho
 *      desabilitado; gatilho removido) → RECUSARIA pelo postcheck / parcial; restaurada → JA_APLICADA; down volta à impressão;
 *   5. controle positivo da prova de preservação: uma linha de cada tabela escrita na própria transação é contada;
 *   6. falha REAL: outra sessão escreve em ia_credito_lotes (ROW EXCLUSIVE) → a FK da 116 espera SHARE ROW EXCLUSIVE e
 *      estoura o lock_timeout → NAO_COMMITADA, nada criado; marcador renomeado → retomada aplica; down.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
type Resultado = { resultado: string; motivo?: string; mensagem?: string; falha?: { etapa: string; mensagem: string }; etapas?: string[];
  estado?: Record<string, unknown>; checks?: Record<string, string>; commits?: Record<string, string>; commitadas?: string[]; marcador?: string;
  contagens?: { lotesPorOrigem: Record<string, number>; notificacoesPorTipo: Record<string, number>; novas?: Record<string, number> };
  contagensAntes?: { lotesPorOrigem: Record<string, number>; notificacoesPorTipo: Record<string, number> };
  contagensDepois?: { lotesPorOrigem: Record<string, number>; notificacoesPorTipo: Record<string, number>; novas?: Record<string, number> } };
type Aplicador = { SQL_IDENTIDADE: string; conferir(o: unknown): Promise<Resultado>; executar(o: unknown): Promise<Resultado> };
const stg = exigir(join(raiz, "scripts/migration-116-staging.cjs")) as Aplicador;
const { SQL_PRESERVACAO, PRESERVADAS } = exigir(join(raiz, "scripts/migration-116-comum.cjs")) as { SQL_PRESERVACAO: string; PRESERVADAS: string[] };
// Configuração FICTÍCIA: só satisfaz a trava de alvo; a URL nunca é usada (o cliente abaixo a ignora).
const ENV_STG = { RENDER: "true", RENDER_SERVICE_ID: "srv-daif418ae00c73e8k2gg", KIDMAIS_DEPLOY_ENV: "staging", DATABASE_SSL: "false",
  DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91" };
const IDENTIDADE = { db: "kidmais_staging_1z91", tls: false, servidor_privado: true };
const MINIMO = "kidmais_teste_minimo_116";
const DOWN116 = readFileSync(resolve(raiz, "database/rollback/20261103_116_franquias_ciclo_down.sql"), "utf8");
const SENHA_FALSA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;

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

test("aplicador 116 real: parcial, papel mínimo não superusuário, preservação, postcheck no catálogo real, F1 com a 116, deriva, down, falha e retomada", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const dirs: string[] = [];
  const novoDir = () => { const d = mkdtempSync(join(tmpdir(), "aplicador-116-")); dirs.push(d); return d; };
  const BACKUP = "PITR 2026-11-04T09:00Z teste";
  const executar = (dir = novoDir(), papel?: string) => stg.executar({ env: ENV_STG, backup: BACKUP, dir, raiz, disco: () => {}, Client: clienteDescartavel({ papel }) });
  const conferir = (papel?: string) => stg.conferir({ env: ENV_STG, raiz, Client: clienteDescartavel({ papel }) });
  const emTx = async <T>(w: (tx: DbExecutor) => Promise<T>): Promise<T> => {
    await c.query("BEGIN");
    try { const r = await w(c as unknown as DbExecutor); await c.query("COMMIT"); return r; } catch (e) { await c.query("ROLLBACK"); throw e; }
  };
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
  /** As 4 tabelas que a 116 trava, linha a linha com xmin: o retrato que ela não pode mudar. */
  const dados = async () => (await c.query<{ h: string }>(`SELECT md5(concat_ws('|', ${PRESERVADAS.map((t) =>
      `(SELECT string_agg(md5(x::text) || ':' || x.xmin::text, ',' ORDER BY md5(x::text)) FROM (SELECT tb.*, tb.xmin FROM public.${t} tb) x)`).join(", ")})) AS h`)).rows[0].h;
  /** Recusa: conferência RECUSARIA com o motivo e aplicação FALHA sem commit; a impressão e os dados não mudam. */
  const recusa = async (motivo: RegExp, papel?: string) => {
    const antes = await impressao(), linhas = await dados();
    const r = await conferir(papel);
    assert.equal(r.resultado, "RECUSARIA", JSON.stringify(r)); assert.match(r.motivo!, motivo);
    const e = await executar(novoDir(), papel);
    assert.equal(e.resultado, "FALHA", JSON.stringify(e)); assert.match(e.falha!.mensagem, motivo); assert.deepEqual(e.commitadas, []);
    assert.equal(await impressao(), antes, "nada mudou: " + motivo.source); assert.equal(await dados(), linhas);
  };
  const instalada = async () => emTx((tx) => franquiasInstaladas(tx));
  const admin = (await c.query<{ u: string }>("SELECT current_user AS u")).rows[0].u.replace(/"/g, '""');
  try {
    assert.equal(await instalada(), false, "modelo sem a 116");
    // Dados reais nas 4 tabelas travadas pela 116.
    const empresa = (await c.query("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet aplicador 116', 'PROVISIONAMENTO') RETURNING id::text AS id",
      [`a116${randomBytes(4).toString("hex")}`])).rows[0].id as string;
    await c.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid", [empresa]);
    const usuario = (await c.query("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Op 116', $2, 'ADMINISTRATIVO', true) RETURNING id::text AS id",
      [`op${randomBytes(4).toString("hex")}@example.test`, SENHA_FALSA])).rows[0].id as string;
    await emTx((tx) => abrirCarteira(tx, empresa, "CONVITES", "2026-01-15T12:00:00.000Z"));
    await emTx((tx) => creditarLote(tx, { empresaId: empresa, recurso: "CONVITES", origem: "CORTESIA", chaveOrigem: `CORTESIA:aplicador-116-${randomBytes(3).toString("hex")}`,
      quantidade: 10, venceEm: Date.now() + 90 * 86_400_000, ator: "SISTEMA" }));
    await c.query("INSERT INTO ia_credito_notificacoes (empresa_id, tipo, dedupe) VALUES ($1::uuid, 'LOTE_VENCENDO_30', $2)", [empresa, `LOTE_VENCENDO_30:${empresa}`]);
    await c.query("BEGIN");
    let contratacao = "";
    try {
      await c.query("SET LOCAL session_replication_role = replica");
      contratacao = (await c.query(`INSERT INTO assinatura_contratacoes (empresa_id, chave_idempotencia, plano, ciclo, catalogo_versao, valor_regular_centavos, valor_final_centavos,
          criada_por, criada_em, estado, confirmada_em, pagamento_confirmacao_id, provedor_assinatura_id)
        VALUES ($1::uuid, $2, 'PREMIUM', 'MENSAL', 'sintetico', 9900, 9900, $3, clock_timestamp() - interval '1 hour', 'CONFIRMADA', clock_timestamp(), $4, $5) RETURNING id::text AS id`,
      [empresa, randomUUID(), usuario, `pay_${randomBytes(5).toString("hex")}`, `sub_${randomBytes(5).toString("hex")}`])).rows[0].id as string;
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; }
    for (const t of PRESERVADAS) assert.ok(Number((await c.query(`SELECT count(*)::int AS n FROM public.${t}`)).rows[0].n) >= 1, "dados em " + t);
    const linhasIniciais = await dados();

    // 1. Conferência só leitura.
    const antes = await impressao();
    const conf = await conferir();
    assert.equal(conf.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(conf));
    assert.deepEqual(conf.checks, { "precheck 116": "PASS" }); assert.equal(conf.estado!.objetos, 0);
    assert.ok((conf.contagens!.lotesPorOrigem.CORTESIA ?? 0) >= 1 && (conf.contagens!.notificacoesPorTipo.LOTE_VENCENDO_30 ?? 0) >= 1, JSON.stringify(conf.contagens));
    assert.equal(conf.contagens!.novas, undefined);
    assert.equal(await impressao(), antes); assert.equal(await dados(), linhasIniciais);

    // 2. Aplicação parcial simulada: a função da 116 já existe.
    await c.query("CREATE FUNCTION public.kidmais_116_somente_insercao() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$");
    try { await recusa(/APLICACAO_PARCIAL_116 tabelas 0\/2, gatilhos 0\/1, tipos 0\/1$/); } finally { await c.query("DROP FUNCTION public.kidmais_116_somente_insercao()"); }
    assert.equal(await impressao(), antes, "estado inicial restaurado");

    // 3. Papel não superusuário: cada falta recusa com o nome; com o mínimo, aplica.
    await c.query(`DROP ROLE IF EXISTS ${MINIMO}`);
    await c.query(`CREATE ROLE ${MINIMO} NOLOGIN NOSUPERUSER`);
    let dirMin = "";
    try {
      await c.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${MINIMO}`);
      await c.query(`GRANT SELECT ON ia_credito_lotes, ia_credito_notificacoes TO ${MINIMO}`);
      await recusa(/SEM_PRIVILEGIO_LEITURA SELECT_CONTRATACOES$/, MINIMO);
      await c.query(`GRANT SELECT ON assinatura_contratacoes TO ${MINIMO}`);
      await recusa(/SEM_PRIVILEGIO_116 DONO_NOTIFICACOES REFERENCES_CARTEIRAS REFERENCES_LOTES REFERENCES_CONTRATACOES SELECT_CARTEIRAS$/, MINIMO);
      await c.query(`ALTER TABLE ia_credito_notificacoes OWNER TO ${MINIMO}`);
      await recusa(/SEM_PRIVILEGIO_116 REFERENCES_CARTEIRAS REFERENCES_LOTES REFERENCES_CONTRATACOES SELECT_CARTEIRAS$/, MINIMO);
      await c.query(`GRANT REFERENCES ON ia_credito_carteiras, ia_credito_lotes TO ${MINIMO}`);
      await recusa(/SEM_PRIVILEGIO_116 REFERENCES_CONTRATACOES SELECT_CARTEIRAS$/, MINIMO);
      await c.query(`GRANT REFERENCES ON assinatura_contratacoes TO ${MINIMO}`);
      // REFERENCES sozinho não basta: sem SELECT na referenciada a criação da FK falha no PG real (rodada 1 deste teste).
      await recusa(/SEM_PRIVILEGIO_116 SELECT_CARTEIRAS$/, MINIMO);
      await c.query(`GRANT SELECT ON ia_credito_carteiras TO ${MINIMO}`);
      const antesDono = await impressao();
      const pronta = await conferir(MINIMO);
      assert.equal(pronta.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(pronta)); assert.equal(pronta.estado!.papel_trocado, true);
      await c.query(`REVOKE CREATE ON SCHEMA public FROM ${MINIMO}`);
      try { await recusa(/SEM_PRIVILEGIO_116 CREATE$/, MINIMO); } finally { await c.query(`GRANT CREATE ON SCHEMA public TO ${MINIMO}`); }
      assert.equal(await impressao(), antesDono);
      dirMin = novoDir();
      const ap = await executar(dirMin, MINIMO);
      assert.equal(ap.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(ap));
      assert.deepEqual(ap.commits, { 116: "CONFIRMADO" }); assert.deepEqual(ap.etapas, ["precheck 116", "migration 116", "postcheck 116"]);
      assert.deepEqual(ap.contagensDepois!.lotesPorOrigem, ap.contagensAntes!.lotesPorOrigem);
      assert.deepEqual(ap.contagensDepois!.notificacoesPorTipo, ap.contagensAntes!.notificacoesPorTipo);
      assert.deepEqual(ap.contagensDepois!.novas, { franquias_ciclo: 0, pendencias: 0, pendencias_abertas: 0 });
      const m = JSON.parse(readFileSync(ap.marcador!, "utf8"));
      assert.deepEqual(m.etapas.find((e: { nome: string }) => e.nome === "migration 116").antesDoCommit, { preservacao: "PASS", "postcheck 116": "PASS" });
      assert.equal(await dados(), linhasIniciais, "nenhuma linha das 4 tabelas reescrita (xmin incluído)");
      assert.equal(await instalada(), true, "o código da F1 enxerga a 116");

      // 4. F1 com a 116: a sincronização registra a pendência (intenção); o postcheck a aceita como legítima.
      assert.equal(await emTx((tx) => registrarPendenciaFranquia(tx, empresa, contratacao)), true);
      const ja = await conferir(MINIMO);
      assert.equal(ja.resultado, "JA_APLICADA_POSTCHECK_PASS", JSON.stringify(ja)); assert.deepEqual(ja.checks, { "postcheck 116": "PASS" });
      assert.deepEqual(ja.contagens!.novas, { franquias_ciclo: 0, pendencias: 1, pendencias_abertas: 1 });
      assert.equal((await conferir()).resultado, "JA_APLICADA_POSTCHECK_PASS");
      await assert.rejects(executar(dirMin, MINIMO), /TENTATIVA_ANTERIOR_REVISAR/);
      // P3-1 do Astra (04/11): com a 116 presente, o postcheck (bloco DO) e as contagens leem as 2 tabelas novas. Cada falta
      // é recusada pelo nome ANTES de qualquer leitura de dados (o dono pode revogar de si mesmo; plpgsql vem de PUBLIC).
      for (const [revogar, restaurar, motivo] of [
        [`REVOKE SELECT ON ia_credito_franquias_ciclo FROM ${MINIMO}`, `GRANT SELECT ON ia_credito_franquias_ciclo TO ${MINIMO}`, /SEM_PRIVILEGIO_116_PRESENTE SELECT_FRANQUIAS_CICLO$/],
        [`REVOKE SELECT ON ia_credito_franquia_pendencias FROM ${MINIMO}`, `GRANT SELECT ON ia_credito_franquia_pendencias TO ${MINIMO}`, /SEM_PRIVILEGIO_116_PRESENTE SELECT_PENDENCIAS$/],
        ["REVOKE USAGE ON LANGUAGE plpgsql FROM PUBLIC", "GRANT USAGE ON LANGUAGE plpgsql TO PUBLIC", /SEM_PRIVILEGIO_116_PRESENTE LINGUAGEM$/],
      ] as const) {
        await c.query(revogar);
        try { await recusa(motivo, MINIMO); } finally { await c.query(restaurar); }
        assert.equal((await conferir(MINIMO)).resultado, "JA_APLICADA_POSTCHECK_PASS", "restaurado: " + motivo.source);
      }
      // Deriva da 116: gatilho desabilitado (5 objetos, postcheck recusa) e gatilho removido (4 objetos, parcial).
      const gatilho = "ia_credito_franquias_ciclo_116_somente_insercao";
      for (const [derivar, restaurar, motivo] of [
        [`ALTER TABLE ia_credito_franquias_ciclo DISABLE TRIGGER ${gatilho}`, `ALTER TABLE ia_credito_franquias_ciclo ENABLE TRIGGER ${gatilho}`,
          /116 postcheck: definição das tabelas novas divergente/],
        [`DROP TRIGGER ${gatilho} ON ia_credito_franquias_ciclo`,
          `CREATE TRIGGER ${gatilho} BEFORE UPDATE OR DELETE ON ia_credito_franquias_ciclo FOR EACH ROW EXECUTE FUNCTION kidmais_116_somente_insercao()`,
          /APLICACAO_PARCIAL_116 gatilhos 0\/1$/],
      ] as const) {
        await c.query(`SET ROLE ${MINIMO}`); await c.query(derivar); await c.query("RESET ROLE");
        try {
          const d = await conferir();
          assert.equal(d.resultado, "RECUSARIA", derivar.slice(0, 60) + JSON.stringify(d)); assert.match(d.motivo!, motivo);
        } finally { await c.query(`SET ROLE ${MINIMO}`); await c.query(restaurar); await c.query("RESET ROLE"); }
        assert.equal((await conferir()).resultado, "JA_APLICADA_POSTCHECK_PASS", "restaurado: " + derivar.slice(0, 60));
      }

      // Down (só no descartável, sem trilha financeira; a pendência é só intenção e sai junto), pelo dono.
      await c.query(`SET ROLE ${MINIMO}`); await c.query(DOWN116); await c.query("RESET ROLE");
      assert.equal(await impressao(), antesDono, "down voltou ao estado do dono");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      await c.query("RESET ROLE").catch(() => undefined);
      await c.query(`REASSIGN OWNED BY ${MINIMO} TO "${admin}"`); await c.query(`DROP OWNED BY ${MINIMO}`); await c.query(`DROP ROLE ${MINIMO}`);
    }
    assert.equal(await instalada(), false, "down voltou ao estado inicial");
    assert.equal(await impressao(), antes, "impressão inicial depois do down");
    assert.equal(await dados(), linhasIniciais, "down não reescreveu as 4 tabelas");

    // 5. Controle positivo da prova de preservação: cada tabela escrita na própria transação é contada.
    for (const [t, escrita] of [
      ["ia_credito_notificacoes", "UPDATE ia_credito_notificacoes SET tentativas = tentativas WHERE empresa_id = $1::uuid"],
      ["ia_credito_lotes", "UPDATE ia_credito_lotes SET bloqueado = bloqueado WHERE empresa_id = $1::uuid"],
      ["ia_credito_carteiras", "UPDATE ia_credito_carteiras SET bloqueado = bloqueado WHERE empresa_id = $1::uuid"],
      ["assinatura_contratacoes", "UPDATE assinatura_contratacoes SET valor_final_centavos = valor_final_centavos WHERE empresa_id = $1::uuid"],
    ] as const) {
      await c.query("BEGIN");
      try {
        await c.query("SET LOCAL session_replication_role = replica");
        assert.equal((await c.query(SQL_PRESERVACAO)).rows[0][t], 0, t + " antes");
        await c.query(escrita, [empresa]);
        const p = (await c.query(SQL_PRESERVACAO)).rows[0];
        assert.equal(p[t], 1, t + " escrita contada"); assert.ok(PRESERVADAS.filter((k) => k !== t).every((k) => p[k] === 0), t + " só ela");
      } finally { await c.query("ROLLBACK"); }
    }

    // 6. Falha real: outra sessão escreve em ia_credito_lotes; a FK da 116 estoura o lock_timeout de 5 s do SQL.
    const trava = await conectarDescartavel({ travar: false });
    const dirFalha = novoDir();
    try {
      await trava.query("BEGIN");
      // ROW EXCLUSIVE deixa passar o catálogo, as contagens e o precheck, mas conflita com o SHARE ROW EXCLUSIVE da FK.
      await trava.query("LOCK TABLE ia_credito_lotes IN ROW EXCLUSIVE MODE");
      const inicio = Date.now();
      const f = await executar(dirFalha);
      assert.ok(Date.now() - inicio >= 4500, "esperou o lock_timeout");
      assert.equal(f.resultado, "FALHA", JSON.stringify(f));
      assert.deepEqual(f.commits, { 116: "NAO_COMMITADA" }); assert.equal(f.falha!.etapa, "migration 116");
      assert.match(f.falha!.mensagem, /lock timeout/);
      await trava.query("ROLLBACK");
    } finally { await trava.query("ROLLBACK").catch(() => undefined); await encerrarDescartavel(trava); }
    assert.equal(await instalada(), false, "nada criado");
    assert.equal(await impressao(), antes);
    await assert.rejects(executar(dirFalha), /TENTATIVA_ANTERIOR_REVISAR/);
    renameSync(join(dirFalha, "migration-116.json"), join(dirFalha, "migration-116.2026-11-04T09-00.json"));
    const retomada = await executar(dirFalha);
    assert.equal(retomada.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(retomada));
    assert.deepEqual(retomada.commits, { 116: "CONFIRMADO" });
    assert.equal((await conferir()).resultado, "JA_APLICADA_POSTCHECK_PASS");
    assert.equal(await dados(), linhasIniciais, "retomada também não reescreveu linhas");
    await c.query(DOWN116);
    assert.equal(await impressao(), antes, "limpo ao final");
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await encerrarDescartavel(c);
  }
});
