import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { cenario, dia } from "../../scripts/integracao-importados-test-support.ts";

/**
 * 05/11/2026 — APLICADOR REAL da 114 (scripts/migration-114-staging.cjs) no PostgreSQL descartável. O modelo 114 já traz a
 * migration: o teste roda o DOWN primeiro para chegar aos corpos da cadeia 108/109, e isso também prova, no catálogo real, que
 * os hashes "antes" do aplicador são os que o down devolve. Única substituição: o cliente do aplicador conecta ao cluster
 * descartável e responde à consulta de identidade como o banco de staging. Toda recusa compara a IMPRESSÃO do schema public e
 * o retrato das 4 tabelas (com xmin). Casos:
 *   1. conferência só leitura → PRONTA, nada muda;
 *   2. corpo divergente de uma função; gatilho desligado (BEFORE e deferido), em ENABLE REPLICA, recriado só para INSERT, com WHEN e sem o
 *      adiamento → recusa pelo nome, nada escrito;
 *   3. papel NÃO superusuário: sem SELECT nas tabelas, sem ser dono e sem CREATE, cada falta recusada com o nome; com o mínimo
 *      (dono das 2 funções + CREATE em public + SELECT nas 4 tabelas), APLICA (estado, preservação e prova na transação; nenhuma
 *      linha reescrita);
 *   4. depois: conferência JA_APLICADA (como o dono e como admin), com prova funcional no catálogo real; escrita real sem a trava =
 *      KD114; com a trava grava; trava de outra sessão não vale; segunda tentativa recusada pelo marcador; EXECUTE revogado de PUBLIC,
 *      corpo da função nova afrouxado (qualquer advisory do backend) e atributos trocados → recusa pelo nome;
 *   5. controle positivo da prova de preservação nas 4 tabelas: INSERT em subtransação desfeita e TRUNCATE; em fechamentos, UPDATE e DELETE
 *      de linha real. Os INSERT usam, só naquela transação desfeita, gatilhos desligados e colunas sem NOT NULL/CHECK;
 *   6. falha REAL: outra sessão com o pg_proc da função preso numa transação aberta → estoura o lock_timeout da 114 →
 *      NAO_COMMITADA, nada criado; marcador renomeado → retomada aplica como admin; a impressão volta à inicial.
 * O modelo termina como começou (114 aplicada, donos originais, papel removido).
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
type Resultado = { resultado: string; motivo?: string; mensagem?: string; falha?: { etapa: string; mensagem: string }; etapas?: string[]; provaFuncional?: string;
  provaFuncionalDepois?: string; estado?: { m114: string }; estadoDepois?: { m114: string }; commits?: Record<string, string>; commitadas?: string[]; marcador?: string };
type Aplicador = { SQL_IDENTIDADE: string; conferir(o: unknown): Promise<Resultado>; executar(o: unknown): Promise<Resultado> };
const stg = exigir(join(raiz, "scripts/migration-114-staging.cjs")) as Aplicador;
const { SQL_PRESERVACAO, SQL_EXIGIR, SQL_TRAVAR, PRESERVADAS, CORPOS, exigirPreservacao } = exigir(join(raiz, "scripts/migration-114-comum.cjs")) as {
  SQL_PRESERVACAO: string; SQL_EXIGIR: string; SQL_TRAVAR: string; PRESERVADAS: string[]; exigirPreservacao(l: unknown[], a: unknown[]): void; CORPOS: { antes: { lock: string; revisao: string }; depois: { lock: string; revisao: string } } };
// Configuração FICTÍCIA: só satisfaz a trava de alvo; a URL nunca é usada (o cliente abaixo a ignora).
const ENV_STG = { RENDER: "true", RENDER_SERVICE_ID: "srv-daif418ae00c73e8k2gg", KIDMAIS_DEPLOY_ENV: "staging", DATABASE_SSL: "false",
  DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91" };
const IDENTIDADE = { db: "kidmais_staging_1z91", tls: false, servidor_privado: true };
const MINIMO = "kidmais_teste_minimo_114";
const UP = readFileSync(resolve(raiz, "database/migrations/20261031_114_trava_configuracao_gatilhos.sql"), "utf8");
const DOWN = readFileSync(resolve(raiz, "database/rollback/20261031_114_trava_configuracao_gatilhos_down.sql"), "utf8");
const F_LOCK = "public.kidmais019_lock_ocupacao()";
const F_REVISAO = "public.kidmais_validar_agenda_revisao()";
const F_114 = "public.kidmais114_exigir_configuracao(uuid)";

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

test("aplicador 114 real: corpo e gatilho divergentes, papel mínimo não superusuário, preservação, prova funcional no catálogo real, falha e retomada", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const dirs: string[] = [];
  const novoDir = () => { const d = mkdtempSync(join(tmpdir(), "aplicador-114-")); dirs.push(d); return d; };
  const BACKUP = "PITR 2026-11-05T22:00Z teste";
  const executar = (dir = novoDir(), papel?: string) => stg.executar({ env: ENV_STG, backup: BACKUP, dir, raiz, disco: () => {}, Client: clienteDescartavel({ papel }) });
  const conferir = (papel?: string) => stg.conferir({ env: ENV_STG, Client: clienteDescartavel({ papel }) });
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
  /** As 4 tabelas protegidas, linha a linha com xmin: o retrato que a 114 não pode mudar. */
  const dados = async () => (await c.query<{ h: string }>(`SELECT md5(concat_ws('|', ${PRESERVADAS.map((tb) =>
      `(SELECT string_agg(md5(x::text) || ':' || x.xmin::text, ',' ORDER BY md5(x::text)) FROM (SELECT tb.*, tb.xmin FROM public.${tb} tb) x)`).join(", ")})) AS h`)).rows[0].h;
  /** Recusa: conferência RECUSARIA com o motivo e aplicação FALHA sem commit; a impressão e os dados não mudam. */
  const recusa = async (motivo: RegExp, papel?: string) => {
    const antes = await impressao(), linhas = await dados();
    const r = await conferir(papel);
    assert.equal(r.resultado, "RECUSARIA", JSON.stringify(r)); assert.match(r.motivo!, motivo);
    const e = await executar(novoDir(), papel);
    assert.equal(e.resultado, "FALHA", JSON.stringify(e)); assert.match(e.falha!.mensagem, motivo); assert.deepEqual(e.commitadas, []);
    assert.equal(await impressao(), antes, "nada mudou: " + motivo.source); assert.equal(await dados(), linhas);
  };
  const f114 = async () => (await c.query<{ f: boolean }>(`SELECT to_regprocedure('${F_114}') IS NOT NULL AS f`)).rows[0].f;
  const hash = async (f: string) => (await c.query<{ h: string }>(`SELECT encode(sha256(convert_to(replace(prosrc,E'\\r',''),'UTF8')),'hex') AS h FROM pg_proc WHERE oid = to_regprocedure('${f}')`)).rows[0].h;
  const travar = (empresa: string) => c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('kidmais:agenda-config:' || $1::text, 0))", [empresa]);
  const createPublico = (await c.query<{ p: boolean }>("SELECT has_schema_privilege('public', 'public', 'CREATE') AS p")).rows[0].p;
  const donoOriginal = (await c.query<{ u: string }>(`SELECT pg_get_userbyid(proowner) AS u FROM pg_proc WHERE oid = to_regprocedure('${F_LOCK}')`)).rows[0].u.replace(/"/g, '""');
  const restaurarDonos = async () => {
    await c.query(`ALTER FUNCTION ${F_LOCK} OWNER TO "${donoOriginal}"`);
    await c.query(`ALTER FUNCTION ${F_REVISAO} OWNER TO "${donoOriginal}"`);
  };
  const c0 = await cenario(c, 0);
  try {
    assert.deepEqual([await hash(F_LOCK), await hash(F_REVISAO), await f114()], [CORPOS.depois.lock, CORPOS.depois.revisao, true], "modelo com a 114");
    // Uma festa real em fechamentos (o retrato precisa cobrir linha de verdade) e, depois, os corpos da cadeia 108/109 pelo down.
    await c.query("BEGIN"); await travar(c0.empresa);
    const festa = (await c.query<{ id: string }>(
      `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
          categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
        SELECT $1::date, '15:00', '19:00', (SELECT id FROM configuracao_agenda WHERE codigo = $4), $2::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
               'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO' FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $3::uuid RETURNING fechamentos.id::text AS id`,
      [dia(90), c0.empresa, c0.pacote, c0.agendaCodigo])).rows[0].id;
    await c.query("COMMIT");
    await c.query(DOWN);
    assert.deepEqual([await hash(F_LOCK), await hash(F_REVISAO), await f114()], [CORPOS.antes.lock, CORPOS.antes.revisao, false], "down devolve os hashes 'antes' do aplicador");
    const impressaoPre = await impressao(), linhasPre = await dados();

    // 1. Conferência só leitura.
    const pronta = await conferir();
    assert.equal(pronta.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(pronta));
    assert.equal(await impressao(), impressaoPre); assert.equal(await dados(), linhasPre);

    // 2. Corpo divergente (uma função só, corpo restaurado byte a byte) e gatilhos desligados.
    const def = (await c.query<{ d: string }>(`SELECT pg_get_functiondef(to_regprocedure('${F_REVISAO}')) AS d`)).rows[0].d;
    await c.query(def.replace(/\$function\$\s*$/, "-- divergente\n$function$"));
    assert.notEqual(await hash(F_REVISAO), CORPOS.antes.revisao, "corpo alterado");
    await recusa(/CORPOS_DIVERGENTES_114 f114=false lock=eb5f187f revisao=(?!8476ec76)/);
    await c.query(def);
    assert.equal(await hash(F_REVISAO), CORPOS.antes.revisao, "corpo restaurado");
    for (const [g, tb] of [["festa019_lock_contrato", "contratos"], ["fr_agenda_validar_trg", "fechamento_revisoes"], ["fr_confirmacao_agenda_trg", "fechamentos"]]) {
      await c.query(`ALTER TABLE public.${tb} DISABLE TRIGGER ${g}`);
      await recusa(new RegExp("GATILHO_DIVERGENTE_114 " + g));
      await c.query(`ALTER TABLE public.${tb} ENABLE TRIGGER ${g}`);
    }
    // Mesmo nome, tabela e função, sem proteger a escrita normal.
    await c.query("ALTER TABLE public.contratos ENABLE REPLICA TRIGGER festa019_lock_contrato");
    await recusa(/GATILHO_DIVERGENTE_114 festa019_lock_contrato/);
    await c.query("ALTER TABLE public.contratos ENABLE TRIGGER festa019_lock_contrato");
    const recriar = async (g: string, tb: string, novo: string) => {
      const original = (await c.query<{ d: string }>("SELECT pg_get_triggerdef(oid) AS d FROM pg_trigger WHERE tgname = $1 AND tgrelid = $2::regclass", [g, "public." + tb])).rows[0].d;
      await c.query(`DROP TRIGGER ${g} ON public.${tb}`); await c.query(novo);
      await recusa(new RegExp("GATILHO_DIVERGENTE_114 " + g));
      await c.query(`DROP TRIGGER ${g} ON public.${tb}`); await c.query(original);
    };
    await recriar("festa019_lock_fluxo", "contrato_fluxos", `CREATE TRIGGER festa019_lock_fluxo BEFORE INSERT ON public.contrato_fluxos FOR EACH ROW EXECUTE FUNCTION ${F_LOCK}`);
    await recriar("festa019_lock_revisao", "fechamento_revisoes", `CREATE TRIGGER festa019_lock_revisao BEFORE INSERT OR UPDATE ON public.fechamento_revisoes FOR EACH ROW WHEN (false) EXECUTE FUNCTION ${F_LOCK}`);
    await recriar("fr_confirmacao_agenda_trg", "fechamentos", `CREATE CONSTRAINT TRIGGER fr_confirmacao_agenda_trg AFTER INSERT OR UPDATE ON public.fechamentos DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION ${F_REVISAO}`);
    await recriar("fr_agenda_validar_trg", "fechamento_revisoes", `CREATE CONSTRAINT TRIGGER fr_agenda_validar_trg AFTER INSERT OR UPDATE ON public.fechamento_revisoes NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION ${F_REVISAO}`);
    assert.equal(await impressao(), impressaoPre, "gatilhos e corpo como antes");

    // 3. Papel mínimo, não superusuário: cada falta recusada pelo nome.
    await c.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MINIMO}') THEN EXECUTE 'DROP OWNED BY ${MINIMO}'; EXECUTE 'DROP ROLE ${MINIMO}'; END IF; END $$`);
    await c.query(`CREATE ROLE ${MINIMO} NOLOGIN NOSUPERUSER`);
    await c.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await c.query(`GRANT USAGE ON SCHEMA public TO ${MINIMO}`);
    await recusa(/SEM_PRIVILEGIO_LEITURA SELECT_TABELAS/, MINIMO);
    await c.query(`GRANT SELECT ON ${PRESERVADAS.map((tb) => "public." + tb).join(", ")} TO ${MINIMO}`);
    await recusa(/SEM_PRIVILEGIO_114 DONO_LOCK DONO_REVISAO CREATE/, MINIMO);
    await c.query(`ALTER FUNCTION ${F_LOCK} OWNER TO ${MINIMO}`);
    await recusa(/SEM_PRIVILEGIO_114 DONO_REVISAO CREATE/, MINIMO);
    await c.query(`ALTER FUNCTION ${F_REVISAO} OWNER TO ${MINIMO}`);
    await recusa(/SEM_PRIVILEGIO_114 CREATE/, MINIMO);
    await c.query(`GRANT CREATE ON SCHEMA public TO ${MINIMO}`);
    assert.equal((await conferir(MINIMO)).resultado, "PRONTA_PARA_APLICAR");

    const dirMinimo = novoDir();
    const aplicada = await executar(dirMinimo, MINIMO);
    assert.equal(aplicada.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(aplicada));
    assert.deepEqual(aplicada.commits, { 114: "CONFIRMADO" }); assert.equal(aplicada.provaFuncionalDepois, "PASS");
    assert.deepEqual([await hash(F_LOCK), await hash(F_REVISAO), await f114()], [CORPOS.depois.lock, CORPOS.depois.revisao, true]);
    assert.equal(await dados(), linhasPre, "nenhuma linha das 4 tabelas reescrita");

    // 4. Depois: conferências, gatilho real, marcador e EXECUTE.
    for (const papel of [MINIMO, undefined]) {
      const r = await conferir(papel);
      assert.equal(r.resultado, "JA_APLICADA_POSTCHECK_PASS", JSON.stringify(r)); assert.equal(r.provaFuncional, "PASS");
    }
    await c.query("BEGIN");
    await assert.rejects(c.query("UPDATE fechamentos SET convidados = convidados WHERE id = $1::uuid", [festa]), (e: { code?: string }) => e.code === "KD114", "sem a trava");
    await c.query("ROLLBACK");
    await c.query("BEGIN"); await travar(c0.empresa);
    await c.query("UPDATE fechamentos SET convidados = convidados WHERE id = $1::uuid", [festa]);
    await c.query("ROLLBACK");
    // Trava de OUTRA sessão não vale para esta.
    const outraSessao = await conectarDescartavel({ travar: false });
    try {
      await outraSessao.query("BEGIN"); await outraSessao.query(SQL_TRAVAR, [c0.empresa]);
      await c.query("BEGIN");
      await assert.rejects(c.query(SQL_EXIGIR, [c0.empresa]), (e: { code?: string }) => e.code === "KD114", "trava de outra sessão");
      await c.query("ROLLBACK");
    } finally { await c.query("ROLLBACK").catch(() => undefined); await encerrarDescartavel(outraSessao, false); }
    await assert.rejects(executar(dirMinimo, MINIMO), /TENTATIVA_ANTERIOR_REVISAR/);
    await c.query(`REVOKE EXECUTE ON FUNCTION ${F_114} FROM PUBLIC`);
    const semExecute = await conferir(MINIMO);
    assert.equal(semExecute.resultado, "RECUSARIA", JSON.stringify(semExecute)); assert.match(semExecute.motivo!, /EXECUTE_RESTRITO_114/);
    await c.query(`GRANT EXECUTE ON FUNCTION ${F_114} TO PUBLIC`);
    assert.equal((await conferir(MINIMO)).resultado, "JA_APLICADA_POSTCHECK_PASS");

    // Função nova afrouxada (a trava de A libera B; a prova da v1 não via isso): o hash recusa antes da prova.
    const defExigir = (await c.query<{ d: string }>(`SELECT pg_get_functiondef(to_regprocedure('${F_114}')) AS d`)).rows[0].d;
    await c.query(`CREATE OR REPLACE FUNCTION ${F_114.replace("(uuid)", "(emp uuid)")} RETURNS void LANGUAGE plpgsql STABLE SET search_path = public, pg_catalog AS $fn$
      BEGIN IF emp IS NULL THEN RETURN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_locks l WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid()) THEN RAISE EXCEPTION 'x' USING ERRCODE = 'KD114'; END IF;
      END $fn$`);
    const afrouxada = await conferir(MINIMO);
    assert.equal(afrouxada.resultado, "RECUSARIA", JSON.stringify(afrouxada)); assert.match(afrouxada.motivo!, /CORPOS_DIVERGENTES_114 f114=true .*exigir=(?!0f0f6a4a)/);
    await c.query(defExigir);
    // Atributos das 3 funções: mesmo corpo, comportamento diferente.
    for (const [fn, muda, volta, nome] of [
      [F_114, "SECURITY DEFINER", "SECURITY INVOKER", "exigir"], [F_114, "RESET search_path", "SET search_path = public, pg_catalog", "exigir"],
      [F_LOCK, "SECURITY DEFINER", "SECURITY INVOKER", "lock"], [F_REVISAO, "CALLED ON NULL INPUT STABLE", "VOLATILE", "revisao"],
    ]) {
      await c.query(`ALTER FUNCTION ${fn} ${muda}`);
      const r = await conferir(MINIMO);
      assert.equal(r.resultado, "RECUSARIA", JSON.stringify(r)); assert.match(r.motivo!, new RegExp("atributos=" + nome));
      await c.query(`ALTER FUNCTION ${fn} ${volta}`);
    }
    assert.equal((await conferir(MINIMO)).resultado, "JA_APLICADA_POSTCHECK_PASS", "restaurada");

    // 5. Controle positivo da preservação, com o verificador real, nas 4 tabelas (a consulta não é cega em nenhuma). Cada caso em sessão nova
    // (como o aplicador): os contadores guardam o que a sessão ainda não enviou às estatísticas, e o caso anterior não pode contaminar.
    const controle = async (fn: (s: Client) => Promise<void>) => {
      const s = await conectarDescartavel({ travar: false });
      try {
        const antes = (await s.query(SQL_PRESERVACAO)).rows;
        assert.equal(antes.length, PRESERVADAS.length);
        await s.query("BEGIN"); await fn(s);
        const depois = (await s.query(SQL_PRESERVACAO)).rows;
        await s.query("ROLLBACK");
        return () => exigirPreservacao(depois, antes);
      } finally { await s.query("ROLLBACK").catch(() => undefined); await encerrarDescartavel(s, false); }
    };
    const relaxar = (tb: string) => `DO $$ DECLARE r record; BEGIN
        FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.${tb}'::regclass AND contype IN ('c', 'p') LOOP EXECUTE format('ALTER TABLE public.${tb} DROP CONSTRAINT %I CASCADE', r.conname); END LOOP;
        FOR r IN SELECT a.attname FROM pg_attribute a WHERE a.attrelid = 'public.${tb}'::regclass AND a.attnum > 0 AND a.attnotnull AND NOT a.attisdropped LOOP
          EXECUTE format('ALTER TABLE public.${tb} ALTER COLUMN %I DROP NOT NULL', r.attname); END LOOP; END $$`;
    // Controle negativo: DDL sem reescrita, como o da 114, não conta.
    (await controle(async (s) => { await s.query(relaxar("contratos")); }))();
    for (const tb of PRESERVADAS) {
      const emSub = await controle(async (s) => {
        await s.query("SET LOCAL session_replication_role = replica"); await s.query(relaxar(tb));
        await s.query("SAVEPOINT ctl"); await s.query(`INSERT INTO public.${tb} DEFAULT VALUES`); await s.query("ROLLBACK TO SAVEPOINT ctl");
      });
      assert.throws(emSub, new RegExp(`PRESERVACAO_114 .*${tb}=1`), "INSERT em subtransação desfeita em " + tb);
      const truncada = await controle(async (s) => { await s.query("SET LOCAL session_replication_role = replica"); await s.query(`TRUNCATE public.${tb} CASCADE`); });
      assert.throws(truncada, new RegExp(`${tb}=ARQUIVO_TROCADO`), "TRUNCATE em " + tb);
    }
    const atualizada = await controle(async (s) => { await s.query(SQL_TRAVAR, [c0.empresa]); await s.query("UPDATE fechamentos SET convidados = convidados WHERE id = $1::uuid", [festa]); });
    assert.throws(atualizada, /PRESERVACAO_114 fechamentos=1/, "UPDATE");
    const apagada = await controle(async (s) => { await s.query("SET LOCAL session_replication_role = replica"); await s.query("DELETE FROM fechamentos WHERE id = $1::uuid", [festa]); });
    assert.throws(apagada, /PRESERVACAO_114 fechamentos=1/, "DELETE");
    // Cenário do parecer r2: acumulado anterior enviado às estatísticas. O envio zera a leitura de antes (exigida zero), e a escrita depois é contada.
    const reutilizada = await conectarDescartavel({ travar: false });
    try {
      await reutilizada.query("BEGIN"); await reutilizada.query(SQL_TRAVAR, [c0.empresa]);
      await reutilizada.query("UPDATE fechamentos SET convidados = convidados WHERE id = $1::uuid", [festa]); await reutilizada.query("ROLLBACK");
      await reutilizada.query("SELECT pg_stat_force_next_flush()"); await reutilizada.query("SELECT 1");
      const antes = (await reutilizada.query(SQL_PRESERVACAO)).rows;
      exigirPreservacao(antes, antes);
      await reutilizada.query("BEGIN"); await reutilizada.query(SQL_TRAVAR, [c0.empresa]);
      await reutilizada.query("UPDATE fechamentos SET convidados = convidados WHERE id = $1::uuid", [festa]);
      const depois = (await reutilizada.query(SQL_PRESERVACAO)).rows;
      await reutilizada.query("ROLLBACK");
      assert.throws(() => exigirPreservacao(depois, antes), /PRESERVACAO_114 fechamentos=1/, "escrita depois do envio");
    } finally { await reutilizada.query("ROLLBACK").catch(() => undefined); await encerrarDescartavel(reutilizada, false); }
    assert.equal(await dados(), linhasPre, "controles não deixaram rastro");

    // 6. Volta ao estado anterior (down pelo dono), com os donos e o papel desfeitos: impressão igual à inicial.
    await c.query(`SET ROLE ${MINIMO}`); await c.query(DOWN); await c.query("RESET ROLE");
    await restaurarDonos();
    await c.query(`REVOKE CREATE, USAGE ON SCHEMA public FROM ${MINIMO}`);
    await c.query(`REVOKE SELECT ON ${PRESERVADAS.map((tb) => "public." + tb).join(", ")} FROM ${MINIMO}`);
    await c.query(`DROP ROLE ${MINIMO}`);
    assert.equal(await impressao(), impressaoPre, "down devolve a impressão inicial");

    // 7. Falha REAL: a linha da função em pg_proc presa por outra sessão; a 114 espera e estoura o lock_timeout de 5 s.
    const trava = await conectarDescartavel({ travar: false });
    const dirFalha = novoDir();
    try {
      await trava.query("BEGIN");
      await trava.query(`ALTER FUNCTION ${F_LOCK} COST 101`);
      const inicio = Date.now();
      const f = await executar(dirFalha);
      assert.ok(Date.now() - inicio >= 4500, "esperou o lock_timeout");
      assert.equal(f.resultado, "FALHA", JSON.stringify(f));
      assert.deepEqual(f.commits, { 114: "NAO_COMMITADA" }); assert.equal(f.falha!.etapa, "migration 114");
      assert.match(f.falha!.mensagem, /lock timeout/);
      await trava.query("ROLLBACK");
    } finally { await trava.query("ROLLBACK").catch(() => undefined); await encerrarDescartavel(trava, false); }
    assert.equal(await f114(), false, "nada criado");
    assert.equal(await impressao(), impressaoPre);
    await assert.rejects(executar(dirFalha), /TENTATIVA_ANTERIOR_REVISAR/);
    renameSync(join(dirFalha, "migration-114.json"), join(dirFalha, "migration-114.2026-11-05T22-00.json"));
    const retomada = await executar(dirFalha);
    assert.equal(retomada.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(retomada));
    assert.deepEqual(retomada.commits, { 114: "CONFIRMADO" });
    assert.equal((await conferir()).resultado, "JA_APLICADA_POSTCHECK_PASS");
    assert.equal(await dados(), linhasPre, "retomada também não reescreveu linhas");
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.query("RESET ROLE").catch(() => undefined);
    // Modelo como começou: corpos da 114, donos originais, sem o papel, CREATE de public como estava antes do teste.
    if (!(await f114().catch(() => true))) await c.query(UP).catch(() => undefined);
    await restaurarDonos().catch(() => undefined);
    await c.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MINIMO}') THEN EXECUTE 'REASSIGN OWNED BY ${MINIMO} TO "${donoOriginal}"'; EXECUTE 'DROP OWNED BY ${MINIMO}'; EXECUTE 'DROP ROLE ${MINIMO}'; END IF; END $$`).catch(() => undefined);
    if (createPublico) await c.query("GRANT CREATE ON SCHEMA public TO PUBLIC").catch(() => undefined);
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await encerrarDescartavel(c);
  }
});
