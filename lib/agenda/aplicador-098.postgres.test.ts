import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg, { type Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, portaDescartavel, senhaRecusada } from "../comercial/postgres-descartavel.ts";
import { cenario, id } from "../../scripts/integracao-importados-test-support.ts";

/**
 * 23/10/2026, derivado do teste do aplicador da 092–094 — o APLICADOR REAL da 098 (scripts/migration-098-staging.cjs)
 * no PostgreSQL descartável, modelo 097 (inventário inteiro antes da 098, como o staging 22d4ac30). Só pelo
 * check:v1:postgres com KIDMAIS_POSTGRES_DESCARTAVEL. Única substituição: o cliente do aplicador conecta ao cluster
 * descartável e responde à consulta de identidade como o banco de staging responderia. Trava de alvo, identidade e
 * marcador são provados sem banco (scripts/migration-098.test.cjs); aqui, SQL REAL:
 *   1. retrato somente leitura → RETRATO_094, com os tipos por linha iguais aos esperados; conferência → PRONTA; nada criado;
 *   2. papéis: sem CREATE/dono → RECUSARIA e FALHA antes de escrever; dono HERDADO via SET ROLE → PRONTA; membro do
 *      dono SEM herança → RECUSARIA;
 *   3. vestígio parcial (função 098 criada à mão) → recusa; índice novo numa tabela do escopo → retrato DIVERGENTE (tipo I);
 *   3c. transação de outra sessão aberta antes do corte → espera e recusa ANTES de escrever (TRANSACOES_ANTERIORES_AO_CORTE);
 *   3d. aplicador com login NÃO superusuário (membro do administrador: CREATE e dono por herança) e transação antiga de
 *       um TERCEIRO papel que ele não enxerga → conferência RECUSARIA e aplicação FALHA SESSOES_NAO_CLASSIFICAVEIS, sem
 *       escrita (P2-2 da revisão de 24/10/2026);
 *   4. erro REAL dentro da 098 (lock_timeout no gatilho de contratos): DESFEITA_PELO_SERVIDOR, nada aplicado;
 *   5. conexão do aplicador DERRUBADA durante a 098 (pg_terminate_backend enquanto espera lock): INDETERMINADO — e a
 *      conferência mostra o estado real (098 ausente);
 *   6. retomada com os marcadores anteriores renomeados → APLICADA (retrato 094 → 098, COMMIT CONFIRMADO, preservação);
 *   7. retrato depois → RETRATO_098 com os tipos esperados; uso legítimo (combinado A+B) → conferência JA_APLICADA pela
 *      integridade (o postcheck de instalação recusaria); nova aplicação só confere, sem escrita;
 *   8. adulteração (gatilho da 098 desligado) → retrato DIVERGENTE (tipo G) e conferência RECUSARIA; religado → passa.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
type Retrato = { estado: string; hash: string; linhas: number; tipos: Record<string, { n: number; md5: string }>; tiposDivergentes?: Record<string, string[]> };
type Resultado = { resultado: string; motivo?: string; mensagem?: string; falha?: { etapa: string; mensagem: string }; etapas?: string[];
  estado?: Record<string, unknown>; checks?: Record<string, string>; retrato?: Retrato; retratoAntes?: string; retratoDepois?: string;
  contagensAntes?: Record<string, unknown>; contagensDepois?: Record<string, unknown>; commit?: string | null };
type Aplicador = { SQL_IDENTIDADE: string; retratar(o: unknown): Promise<Resultado>; conferir(o: unknown): Promise<Resultado>; executar(o: unknown): Promise<Resultado> };
const stg = exigir(join(raiz, "scripts/migration-098-staging.cjs")) as Aplicador;
const { RETRATOS } = exigir(join(raiz, "scripts/migration-098-comum.cjs")) as { RETRATOS: Record<string, { hash: string; tipos: Record<string, [number, string]> }> };
// Configuração FICTÍCIA: só satisfaz a trava de alvo; a URL nunca é usada (o cliente abaixo a ignora).
const ENV_STG = { RENDER: "true", RENDER_SERVICE_ID: "srv-daif418ae00c73e8k2gg", KIDMAIS_DEPLOY_ENV: "staging", DATABASE_SSL: "false",
  DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91" };
const IDENTIDADE = { db: "kidmais_staging_1z91", tls: false, servidor_privado: true };
const PAPEL = "kidmais_teste_aplicador_098", DONO = "kidmais_teste_dono_098", HERDA = "kidmais_teste_herda_098", SEM = "kidmais_teste_sem_heranca_098";
const INSTALA = ["precheck 098", "migration 098", "postcheck 098", "integridade 098"];
const PRECHECK = "-- Somente leitura. Confirma a 093/094 completas";

function clienteDescartavel(cfg: { papel?: string } = {}) {
  return class {
    c: Client | null = null;
    on() {}
    async connect() {
      this.c = await conectarDescartavel({ travar: false });
      // Como o db.on('error') do aplicador no cliente real: conexão encerrada pelo servidor (caso 5) não vira exceção solta.
      this.c.on("error", () => undefined);
      if (cfg.papel) await this.c.query(`SET ROLE ${cfg.papel}`);
    }
    async query(sql: string) { return sql === stg.SQL_IDENTIDADE ? { rows: [IDENTIDADE] } : this.c!.query(sql); }
    async end() { if (this.c) await this.c.end(); }
  };
}
/**
 * Cliente do aplicador com OUTRO login no mesmo cluster descartável (initdb --auth=trust, só 127.0.0.1 e a porta
 * autorizada), com a mesma conferência de identidade do conectarDescartavel (banco, porta, endereço, cluster_name).
 */
function clienteComLogin(login: string) {
  return class {
    c: Client | null = null;
    on() {}
    async connect() {
      const porta = portaDescartavel();
      this.c = new pg.Client({ host: "127.0.0.1", port: porta, user: login, database: "kidmais_pacotes_v1_descartavel", password: senhaRecusada, application_name: "kidmais-descartavel" });
      this.c.on("error", () => undefined);
      await this.c.connect();
      const id = (await this.c.query<{ db: string; port: number; addr: string; cluster: string; papel: string }>(
        "SELECT current_database() AS db, inet_server_port() AS port, host(inet_server_addr()) AS addr, current_setting('cluster_name') AS cluster, session_user AS papel")).rows[0]!;
      assert.deepEqual([id.db, Number(id.port), id.addr, id.cluster, id.papel], ["kidmais_pacotes_v1_descartavel", porta, "127.0.0.1", "kidmais_descartavel", login]);
    }
    async query(sql: string) { return sql === stg.SQL_IDENTIDADE ? { rows: [IDENTIDADE] } : this.c!.query(sql); }
    async end() { if (this.c) await this.c.end(); }
  };
}
const instalada = async (c: Client) => (await c.query<{ ok: boolean }>(`SELECT to_regprocedure('public.kidmais098_hoje()') IS NOT NULL
  AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'agenda_saloes'::regclass AND attname = 'combinado' AND NOT attisdropped) AS ok`)).rows[0]!.ok;
const marcador = (dir: string) => JSON.parse(readFileSync(join(dir, "migration-098.json"), "utf8"));
const tiposEsperados = (e: string) => Object.fromEntries(Object.entries(RETRATOS[e]!.tipos).map(([k, [n, md5]]) => [k, { n, md5 }]));

/**
 * Inicia a aplicação e, quando o PRECHECK dela estiver rodando (o retrato embutido leva ~1 s, depois do corte e da
 * espera de transações anteriores), outra sessão segura contratos em SHARE (não bloqueia leitura; bloqueia o CREATE
 * TRIGGER da 098). Devolve a execução, a sessão que segura e o pid do aplicador.
 */
async function aplicarComContratosPresos(c: Client, executar: () => Promise<Resultado>) {
  const execucao = executar();
  let terminou: Resultado | null = null;
  void execucao.then((r) => { terminou = r; });
  let aplicador: number | null = null;
  for (let i = 0; i < 400 && aplicador === null && terminou === null; i++) {
    aplicador = (await c.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state = 'active'
      AND left(query, ${PRECHECK.length}) = $1 LIMIT 1`, [PRECHECK])).rows[0]?.pid ?? null;
    if (aplicador === null) await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(aplicador, "precheck do aplicador visto; terminou antes com: " + JSON.stringify(terminou));
  const segura = await conectarDescartavel({ travar: false });
  await segura.query("BEGIN"); await segura.query("LOCK TABLE contratos IN SHARE MODE");
  return { execucao, segura, aplicador, terminou: () => terminou };
}

test("aplicador 098 real no modelo 097: retrato, papéis, parcial, divergência, falhas reais (desfeita e indeterminada), retomada, uso legítimo, adulteração", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const dirs: string[] = [];
  const novoDir = () => { const d = mkdtempSync(join(tmpdir(), "aplicador-098-")); dirs.push(d); return d; };
  const BACKUP = "export 2026-10-23T18:00Z teste";
  const executar = (dir = novoDir(), papel?: string) => stg.executar({ env: ENV_STG, backup: BACKUP, dir, raiz, disco: () => {}, Client: clienteDescartavel({ papel }) });
  const conferir = (papel?: string) => stg.conferir({ env: ENV_STG, raiz, Client: clienteDescartavel({ papel }) });
  const retratar = () => stg.retratar({ env: ENV_STG, raiz, Client: clienteDescartavel() });
  try {
    assert.equal(await instalada(c), false, "modelo 097: 098 ausente");
    // 1. Retrato somente leitura e conferência.
    const r0 = await retratar();
    assert.equal(r0.resultado, "RETRATO_094", JSON.stringify(r0.retrato));
    assert.deepEqual(r0.retrato!.tipos, tiposEsperados("094"), "tipos esperados do estado 094: " + JSON.stringify(Object.fromEntries(Object.entries(r0.retrato!.tipos).map(([k, v]) => [k, [v.n, v.md5]]))));
    const conf = await conferir();
    assert.equal(conf.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(conf));
    assert.deepEqual(conf.checks, { "precheck 098": "PASS" }); assert.equal(conf.retrato!.estado, "094");
    const e = conf.estado as Record<string, unknown>;
    assert.deepEqual([e.m098, e.papel_trocado], ["ausente", false]);
    for (const k of ["d094", "pode_criar", "dono_098"]) assert.equal(e[k], true, k);
    assert.equal(await instalada(c), false);

    // 2a. Papel sem privilégios: só USAGE e SELECT; depois com CREATE, ainda sem ser dono.
    await c.query(`DROP ROLE IF EXISTS ${PAPEL}`);
    await c.query(`CREATE ROLE ${PAPEL} NOLOGIN`);
    try {
      await c.query(`GRANT USAGE ON SCHEMA public TO ${PAPEL}`);
      await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${PAPEL}`);
      const r1 = await conferir(PAPEL);
      assert.equal(r1.resultado, "RECUSARIA", JSON.stringify(r1)); assert.match(r1.motivo!, /SEM_PRIVILEGIO_098 CREATE DONO/);
      assert.equal((r1.estado as { papel_trocado: boolean }).papel_trocado, true, "SET ROLE visto como papel trocado (sem nome)");
      await c.query(`GRANT CREATE ON SCHEMA public TO ${PAPEL}`);
      const r2 = await conferir(PAPEL);
      assert.equal(r2.resultado, "RECUSARIA"); assert.match(r2.motivo!, /SEM_PRIVILEGIO_098 DONO/);
      const dir = novoDir();
      const r3 = await executar(dir, PAPEL);
      assert.equal(r3.resultado, "FALHA"); assert.match(r3.falha!.mensagem, /SEM_PRIVILEGIO_098/); assert.equal(r3.commit, null);
      assert.equal(marcador(dir).situacao, "FALHA");
      assert.equal(await instalada(c), false);
    } finally {
      await c.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${PAPEL}`);
      await c.query(`REVOKE ALL ON SCHEMA public FROM ${PAPEL}`);
      await c.query(`DROP ROLE ${PAPEL}`);
    }

    // 2b. Positivo: o dono dos objetos alterados é um papel herdado via SET ROLE, como no Render; membro do dono SEM
    //     herança não basta. Só conferência; a posse volta ao administrador (o retrato não inclui dono).
    const admin = (await c.query<{ u: string }>("SELECT current_user AS u")).rows[0]!.u;
    await c.query(`CREATE ROLE ${DONO} NOLOGIN`);
    try {
      for (const tabela of ["agenda_saloes", "contratos"]) await c.query(`ALTER TABLE ${tabela} OWNER TO ${DONO}`);
      for (const f of ["kidmais094_conflito_ocupacao(uuid,date,time,time,uuid,uuid,uuid,uuid)", "kidmais019_validar_contrato()", "kidmais_validar_agenda_revisao()"])
        await c.query(`ALTER FUNCTION ${f} OWNER TO ${DONO}`);
      await c.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${DONO}`);
      await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${DONO}`);
      await c.query(`CREATE ROLE ${HERDA} NOLOGIN INHERIT IN ROLE ${DONO}`);
      await c.query(`CREATE ROLE ${SEM} NOLOGIN NOINHERIT IN ROLE ${DONO}`);
      const herdado = await conferir(HERDA);
      assert.equal(herdado.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(herdado));
      const h = herdado.estado as Record<string, unknown>;
      for (const k of ["pode_criar", "dono_098", "papel_trocado"]) assert.equal(h[k], true, "herdado " + k);
      const semHeranca = await conferir(SEM);
      assert.equal(semHeranca.resultado, "RECUSARIA"); assert.match(semHeranca.motivo!, /SEM_PRIVILEGIO_098 .*DONO/);
    } finally {
      await c.query(`DROP ROLE IF EXISTS ${HERDA}`); await c.query(`DROP ROLE IF EXISTS ${SEM}`);
      await c.query(`REASSIGN OWNED BY ${DONO} TO "${admin.replace(/"/g, '""')}"`);
      await c.query(`DROP OWNED BY ${DONO}`); await c.query(`DROP ROLE ${DONO}`);
    }
    assert.equal((await conferir()).resultado, "PRONTA_PARA_APLICAR", "posse restaurada ao administrador");

    // 3a. Vestígio parcial: uma função da 098 criada à mão → recusa na conferência e na aplicação.
    await c.query("CREATE FUNCTION kidmais098_hoje() RETURNS date LANGUAGE sql AS 'SELECT current_date'");
    const parcialConf = await conferir();
    assert.equal(parcialConf.resultado, "RECUSARIA"); assert.match(parcialConf.motivo!, /APLICACAO_PARCIAL_098/);
    const parcial = await executar();
    assert.equal(parcial.resultado, "FALHA"); assert.match(parcial.falha!.mensagem, /APLICACAO_PARCIAL_098/); assert.equal(parcial.commit, null);
    await c.query("DROP FUNCTION kidmais098_hoje()");
    // 3b. Deriva estrutural sem objeto da 098: índice novo numa tabela do escopo → retrato DIVERGENTE só no tipo I.
    await c.query("CREATE INDEX agenda_saloes_deriva_teste ON agenda_saloes (ordem)");
    try {
      const d = await retratar();
      assert.equal(d.resultado, "RETRATO_DIVERGENTE"); assert.deepEqual(d.retrato!.tiposDivergentes!["094"], ["I"]);
      const dc = await conferir();
      assert.equal(dc.resultado, "RECUSARIA"); assert.match(dc.motivo!, /RETRATO_DIVERGENTE esperado 094/);
      const de = await executar();
      assert.equal(de.resultado, "FALHA"); assert.match(de.falha!.mensagem, /RETRATO_DIVERGENTE/); assert.equal(de.commit, null);
    } finally { await c.query("DROP INDEX agenda_saloes_deriva_teste"); }
    assert.equal((await retratar()).resultado, "RETRATO_094");

    // 3c. Transação de outra sessão aberta ANTES do corte: a aplicação espera e recusa antes de escrever.
    const antiga = await conectarDescartavel({ travar: false });
    try {
      await antiga.query("BEGIN"); await antiga.query("SELECT 1 FROM agenda_saloes LIMIT 1");
      const dirAntiga = novoDir();
      const r3c = await stg.executar({ env: ENV_STG, backup: BACKUP, dir: dirAntiga, raiz, disco: () => {}, Client: clienteDescartavel(), tentativas: 4 });
      assert.equal(r3c.resultado, "FALHA", JSON.stringify(r3c)); assert.match(r3c.falha!.mensagem, /TRANSACOES_ANTERIORES_AO_CORTE/); assert.equal(r3c.commit, null);
    } finally { await antiga.query("ROLLBACK").catch(() => {}); await antiga.end(); }
    assert.equal(await instalada(c), false, "3c: nada escrito");

    // 3d. Sessão não classificável (P2-2): o aplicador entra com um login NÃO superusuário, membro do administrador
    //     (CREATE e dono por herança, como o SET role do Render), e um terceiro papel mantém uma transação antiga que
    //     esse login não enxerga em pg_stat_activity.
    const LOGIN = "kidmais_teste_login_098", OUTRO = "kidmais_teste_outro_098";
    const adminNome = (await c.query<{ u: string }>("SELECT current_user AS u")).rows[0]!.u;
    await c.query(`CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER INHERIT IN ROLE "${adminNome.replace(/"/g, '""')}"`);
    await c.query(`CREATE ROLE ${OUTRO} LOGIN NOSUPERUSER`);
    const deFora = new pg.Client({ host: "127.0.0.1", port: portaDescartavel(), user: OUTRO, database: "kidmais_pacotes_v1_descartavel", password: senhaRecusada });
    deFora.on("error", () => undefined);
    try {
      // Sem a sessão de fora: o login enxerga todas as sessões de cliente e a conferência segue PRONTA.
      const limpa = await stg.conferir({ env: ENV_STG, raiz, Client: clienteComLogin(LOGIN) });
      assert.equal(limpa.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(limpa));
      assert.equal((limpa as { sessoes?: { invisiveis: number } }).sessoes?.invisiveis, 0);
      await deFora.connect(); await deFora.query("BEGIN"); await deFora.query("SELECT 1");
      const r3d = await stg.conferir({ env: ENV_STG, raiz, Client: clienteComLogin(LOGIN) });
      assert.equal(r3d.resultado, "RECUSARIA", JSON.stringify(r3d)); assert.match(r3d.motivo!, /SESSOES_NAO_CLASSIFICAVEIS 1/);
      const dirFora = novoDir();
      const a3d = await stg.executar({ env: ENV_STG, backup: BACKUP, dir: dirFora, raiz, disco: () => {}, Client: clienteComLogin(LOGIN), tentativas: 3 });
      assert.equal(a3d.resultado, "FALHA", JSON.stringify(a3d)); assert.match(a3d.falha!.mensagem, /SESSOES_NAO_CLASSIFICAVEIS 1/); assert.equal(a3d.commit, null);
      assert.equal(marcador(dirFora).situacao, "FALHA");
      // O superusuário do teste enxerga a mesma sessão: com ele, ela é classificada (transação anterior), não invisível.
      const visto = await stg.conferir({ env: ENV_STG, raiz, Client: clienteDescartavel() });
      assert.equal((visto as { sessoes?: { invisiveis: number } }).sessoes?.invisiveis, 0);
    } finally {
      await deFora.query("ROLLBACK").catch(() => {}); await deFora.end().catch(() => {});
      await c.query(`DROP ROLE IF EXISTS ${LOGIN}`); await c.query(`DROP ROLE IF EXISTS ${OUTRO}`);
    }
    assert.equal(await instalada(c), false, "3d: nada escrito");
    assert.equal(await instalada(c), false);

    // 4. Erro REAL dentro da 098: contratos presos em SHARE depois do precheck; o CREATE TRIGGER espera o lock_timeout
    //    de 5 s e o servidor desfaz a transação inteira do arquivo (55P03 → DESFEITA_PELO_SERVIDOR).
    const dirFalha = novoDir();
    const p4 = await aplicarComContratosPresos(c, () => executar(dirFalha));
    let falha: Resultado;
    try { falha = await p4.execucao; } finally { await p4.segura.query("ROLLBACK").catch(() => {}); await p4.segura.end(); }
    assert.equal(falha.resultado, "FALHA", JSON.stringify(falha)); assert.equal(falha.falha!.etapa, "migration 098");
    assert.match(falha.falha!.mensagem, /lock timeout/); assert.equal(falha.commit, "DESFEITA_PELO_SERVIDOR");
    assert.equal(marcador(dirFalha).etapas.find((x: { nome: string }) => x.nome === "migration 098").commit, "DESFEITA_PELO_SERVIDOR");
    assert.equal(await instalada(c), false, "098 desfeita pelo servidor");
    await assert.rejects(executar(dirFalha), /TENTATIVA_ANTERIOR_REVISAR/, "falha não se repete sozinha");

    // 5. Conexão do aplicador DERRUBADA enquanto a 098 espera o lock de contratos → sem resposta: INDETERMINADO.
    renameSync(join(dirFalha, "migration-098.json"), join(dirFalha, "migration-098.2026-10-23T18-00Z.json"));
    const p5 = await aplicarComContratosPresos(c, () => executar(dirFalha));
    let derrubada: Resultado;
    try {
      const pidSegura = (await p5.segura.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      let alvo: number | null = null;
      for (let i = 0; i < 200 && alvo === null && p5.terminou() === null; i++) {
        await new Promise((r) => setTimeout(r, 25));
        alvo = (await c.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()
          AND $1 = ANY (pg_blocking_pids(pid)) LIMIT 1`, [pidSegura])).rows[0]?.pid ?? null;
      }
      assert.ok(alvo, "aplicador esperando o lock da 098; terminou antes com: " + JSON.stringify(p5.terminou()));
      assert.equal(alvo, p5.aplicador, "quem espera é a sessão do aplicador");
      await c.query("SELECT pg_terminate_backend($1)", [alvo]);
      derrubada = await p5.execucao;
    } finally { await p5.segura.query("ROLLBACK").catch(() => {}); await p5.segura.end(); }
    assert.equal(derrubada.resultado, "FALHA", JSON.stringify(derrubada)); assert.equal(derrubada.falha!.etapa, "migration 098");
    assert.equal(derrubada.commit, "INDETERMINADO");
    assert.deepEqual(marcador(dirFalha).tentativasAnteriores, ["migration-098.2026-10-23T18-00Z.json"]);
    // Reconciliação: a conferência diz o estado real (aqui, a transação da 098 morreu com o backend).
    const reconc = await conferir();
    assert.equal(reconc.resultado, "PRONTA_PARA_APLICAR"); assert.equal((reconc.estado as { m098: string }).m098, "ausente");

    // 6. Retomada (decisão humana): marcador anterior renomeado, nunca apagado; aplica a 098 com um salão existente.
    const cen = await cenario(c, 0);
    await id(c, "INSERT INTO agenda_saloes (empresa_id, nome) VALUES ($1::uuid, 'Salão A do ensaio') RETURNING id", [cen.empresa]);
    renameSync(join(dirFalha, "migration-098.json"), join(dirFalha, "migration-098.2026-10-23T18-30Z.json"));
    const ok = await executar(dirFalha);
    assert.equal(ok.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(ok));
    assert.deepEqual(ok.etapas, INSTALA); assert.equal(ok.commit, "CONFIRMADO");
    assert.equal(ok.retratoAntes, "094"); assert.equal(ok.retratoDepois, "098");
    assert.ok(Number(ok.contagensAntes!.saloes) >= 1); assert.equal(ok.contagensDepois!.saloes, ok.contagensAntes!.saloes);
    assert.equal(ok.contagensDepois!.resumo_saloes, ok.contagensAntes!.resumo_saloes); assert.equal(ok.contagensDepois!.combinados_ate_corte, 0);
    assert.equal(await instalada(c), true);
    assert.deepEqual(readdirSync(dirFalha).sort(), ["migration-098.2026-10-23T18-00Z.json", "migration-098.2026-10-23T18-30Z.json", "migration-098.json"]);
    assert.deepEqual(marcador(dirFalha).tentativasAnteriores, ["migration-098.2026-10-23T18-00Z.json", "migration-098.2026-10-23T18-30Z.json"]);
    assert.ok(!JSON.stringify(marcador(dirFalha)).includes("senha-ficticia"));
    await assert.rejects(executar(dirFalha), /TENTATIVA_ANTERIOR_REVISAR/);

    // 7. Retrato depois e uso legítimo: combinado A+B. O postcheck de instalação recusaria; a conferência usa a integridade.
    const r7 = await retratar();
    assert.equal(r7.resultado, "RETRATO_098");
    assert.deepEqual(r7.retrato!.tipos, tiposEsperados("098"), "tipos esperados do estado 098: " + JSON.stringify(Object.fromEntries(Object.entries(r7.retrato!.tipos).map(([k, v]) => [k, [v.n, v.md5]]))));
    const salaoB = await id(c, "INSERT INTO agenda_saloes (empresa_id, nome) VALUES ($1::uuid, 'Salão B do ensaio') RETURNING id", [cen.empresa]);
    const salaoA = await id(c, "SELECT id FROM agenda_saloes WHERE empresa_id = $1::uuid AND nome = 'Salão A do ensaio'", [cen.empresa]);
    const membros = [salaoA, salaoB].sort();
    await id(c, "INSERT INTO agenda_saloes (empresa_id, nome, combinado, membros) VALUES ($1::uuid, 'Salão inteiro do ensaio', true, $2::uuid[]) RETURNING id", [cen.empresa, membros]);
    await assert.rejects(c.query(readFileSync(join(raiz, "database/checks/20261023_098_postcheck.sql"), "utf8")), /098 postcheck: salão combinado/);
    const usada = await conferir();
    assert.equal(usada.resultado, "JA_APLICADA_INTEGRIDADE_PASS", JSON.stringify(usada));
    assert.deepEqual(usada.checks, { "integridade 098": "PASS" }); assert.equal((usada as { contagens?: { combinados: number } }).contagens?.combinados, 1);
    const denovo = await executar();
    assert.equal(denovo.resultado, "JA_APLICADA_INTEGRIDADE_PASS", JSON.stringify(denovo)); assert.deepEqual(denovo.etapas, ["integridade 098"]); assert.equal(denovo.commit, null);

    // 8. Adulteração com os objetos presentes: gatilho de guarda desligado → retrato DIVERGENTE (tipo G), RECUSARIA.
    await c.query("ALTER TABLE agenda_saloes DISABLE TRIGGER agenda_saloes_098_guarda_trg");
    try {
      const ad = await retratar();
      assert.equal(ad.resultado, "RETRATO_DIVERGENTE"); assert.deepEqual(ad.retrato!.tiposDivergentes!["098"], ["G"]);
      const adc = await conferir();
      assert.equal(adc.resultado, "RECUSARIA"); assert.match(adc.motivo!, /RETRATO_DIVERGENTE esperado 098/);
    } finally { await c.query("ALTER TABLE agenda_saloes ENABLE TRIGGER agenda_saloes_098_guarda_trg"); }
    assert.equal((await conferir()).resultado, "JA_APLICADA_INTEGRIDADE_PASS");
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    await encerrarDescartavel(c);
  }
});
