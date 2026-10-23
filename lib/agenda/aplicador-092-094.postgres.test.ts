import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { cenario, dia, id } from "../../scripts/integracao-importados-test-support.ts";

/**
 * 23/10/2026, derivado do teste do aplicador da 089 e ampliado pelo parecer do Astra (P2-1, P2-2, P3-1, b, f) — o
 * APLICADOR REAL da 092 → 093 → 094 (scripts/migration-092-094-staging.cjs) no PostgreSQL descartável, modelo 089
 * (092–094 ausentes). Só pelo check:v1:postgres com KIDMAIS_POSTGRES_DESCARTAVEL. Única substituição: o cliente do
 * aplicador conecta ao cluster descartável e responde à consulta de identidade como o banco de staging responderia.
 * Trava de alvo, identidade e marcador são provados sem banco (scripts/migration-092-094.test.cjs); aqui, SQL REAL:
 *   1. conferência só leitura → PRONTA (prechecks 092/093, 094 depois da 093), nada criado;
 *   2. papéis: sem CREATE/dono → RECUSARIA e FALHA antes de escrever; dono HERDADO via SET ROLE → PRONTA (positivo);
 *      membro do dono SEM herança → RECUSARIA;
 *   3. vestígio parcial da 093 → recusa;
 *   4. erro REAL dentro da 093 (lock_timeout): 092 confirmada, 093 DESFEITA_PELO_SERVIDOR, 094 não tentada;
 *   5. conexão do aplicador DERRUBADA durante a 094 (pg_terminate_backend enquanto espera lock): 093 confirmada,
 *      094 INDETERMINADO — e a conferência mostra o estado real (094 ausente);
 *   6. uso legítimo da 093 (capacidade 2, salão) → conferência PRONTA pela integridade (o postcheck de instalação recusaria);
 *   7. retomada pelo prefixo com o marcador anterior renomeado → aplica só a 094, lista a tentativa anterior;
 *   8. uso legítimo da 094 (festa com salão) → conferência JA_APLICADA pela integridade;
 *   9. adulteração com marcadores presentes (gatilho desligado) → integridade recusa; religado → passa;
 *  10. nova aplicação (outro registro) só confere as três integridades; os down ficam fora do aplicador.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
type Resultado = { resultado: string; motivo?: string; mensagem?: string; falha?: { etapa: string; mensagem: string }; etapas?: string[];
  estado?: Record<string, unknown>; checks?: Record<string, string>; estadoDepois?: Record<string, unknown>; contagensDepois?: Record<string, number>;
  migracoesCommitadas?: string[]; migracaoIndeterminada?: string | null };
type Aplicador = { SQL_IDENTIDADE: string; conferir(o: unknown): Promise<Resultado>; executar(o: unknown): Promise<Resultado> };
const stg = exigir(join(raiz, "scripts/migration-092-094-staging.cjs")) as Aplicador;
// Configuração FICTÍCIA: só satisfaz a trava de alvo; a URL nunca é usada (o cliente abaixo a ignora).
const ENV_STG = { RENDER: "true", RENDER_SERVICE_ID: "srv-daif418ae00c73e8k2gg", KIDMAIS_DEPLOY_ENV: "staging", DATABASE_SSL: "false",
  DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91" };
const IDENTIDADE = { db: "kidmais_staging_1z91", tls: false, servidor_privado: true };
const PAPEL = "kidmais_teste_aplicador_092_094", DONO = "kidmais_teste_dono_092_094", HERDA = "kidmais_teste_herda_092_094", SEM = "kidmais_teste_sem_heranca_092_094";
const INSTALA = (id: string) => ["precheck", "migration", "postcheck", "integridade"].map((t) => `${t} ${id}`);

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
const presentes = async (c: Client) => (await c.query<Record<string, boolean>>(`SELECT
  EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'precos_pacote_092_ponto_check') AS m092,
  to_regclass('public.agenda_saloes') IS NOT NULL AS m093,
  to_regprocedure('public.kidmais094_ocupacoes(date,date)') IS NOT NULL AS m094`)).rows[0];
const marcador = (dir: string) => JSON.parse(readFileSync(join(dir, "migration-092-094.json"), "utf8"));

test("aplicador 092–094 real no modelo 089: papéis, parcial, falhas reais (desfeita e indeterminada), uso legítimo, retomada, adulteração", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const dirs: string[] = [];
  const novoDir = () => { const d = mkdtempSync(join(tmpdir(), "aplicador-092-094-")); dirs.push(d); return d; };
  const BACKUP = "export 2026-10-23T03:00Z teste";
  const executar = (dir = novoDir(), papel?: string) => stg.executar({ env: ENV_STG, backup: BACKUP, dir, raiz, disco: () => {}, Client: clienteDescartavel({ papel }) });
  const conferir = (papel?: string) => stg.conferir({ env: ENV_STG, raiz, Client: clienteDescartavel({ papel }) });
  try {
    assert.deepEqual(await presentes(c), { m092: false, m093: false, m094: false }, "modelo 089: 092–094 ausentes");
    // 1. Conferência só leitura.
    const conf = await conferir();
    assert.equal(conf.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(conf));
    assert.deepEqual(conf.checks, { "precheck 092": "PASS", "precheck 093": "PASS", "precheck 094": "APOS_093" });
    const e = conf.estado as Record<string, unknown>;
    assert.deepEqual([e.m092, e.m093, e.m094, e.papel_trocado], ["ausente", "ausente", "ausente", false]);
    for (const k of ["d092", "d093", "d094", "pode_criar", "dono_092", "dono_093", "dono_094", "referencias_093", "referencias_094"]) assert.equal(e[k], true, k);
    assert.deepEqual(await presentes(c), { m092: false, m093: false, m094: false });

    // 2a. Papel sem privilégios: só USAGE e SELECT (nem CREATE nem dono); depois com CREATE, ainda sem ser dono.
    await c.query(`DROP ROLE IF EXISTS ${PAPEL}`);
    await c.query(`CREATE ROLE ${PAPEL} NOLOGIN`);
    try {
      await c.query(`GRANT USAGE ON SCHEMA public TO ${PAPEL}`);
      await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${PAPEL}`);
      const r1 = await conferir(PAPEL);
      assert.equal(r1.resultado, "RECUSARIA"); assert.match(r1.motivo!, /SEM_PRIVILEGIO_092 CREATE DONO/);
      assert.equal((r1.estado as { papel_trocado: boolean }).papel_trocado, true, "SET ROLE visto como papel trocado (sem nome)");
      await c.query(`GRANT CREATE ON SCHEMA public TO ${PAPEL}`);
      const r2 = await conferir(PAPEL);
      assert.equal(r2.resultado, "RECUSARIA"); assert.match(r2.motivo!, /SEM_PRIVILEGIO_092 DONO/);
      const dir = novoDir();
      const r3 = await executar(dir, PAPEL);
      assert.equal(r3.resultado, "FALHA"); assert.match(r3.falha!.mensagem, /SEM_PRIVILEGIO_092/); assert.deepEqual(r3.migracoesCommitadas, []);
      assert.equal(marcador(dir).situacao, "FALHA");
      assert.deepEqual(await presentes(c), { m092: false, m093: false, m094: false });
    } finally {
      await c.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${PAPEL}`);
      await c.query(`REVOKE ALL ON SCHEMA public FROM ${PAPEL}`);
      await c.query(`DROP ROLE ${PAPEL}`);
    }

    // 2b. Positivo (parecer, b): o dono dos objetos alterados é um papel herdado via SET ROLE, como no Render; membro do
    //     dono SEM herança não basta. Só conferência (nada é aplicado com esses papéis); a posse volta ao administrador.
    const admin = (await c.query<{ u: string }>("SELECT current_user AS u")).rows[0].u;
    await c.query(`CREATE ROLE ${DONO} NOLOGIN`);
    try {
      for (const tabela of ["precos_pacote", "fechamento_pacote_snapshots", "configuracao_agenda", "fechamentos", "fechamento_revisoes"]) await c.query(`ALTER TABLE ${tabela} OWNER TO ${DONO}`);
      for (const f of ["kidmais_047_lacunas_escopo(uuid)", "kidmais019_validar_destino(uuid)", "kidmais019_validar_contrato()", "kidmais_validar_agenda_revisao()"]) await c.query(`ALTER FUNCTION ${f} OWNER TO ${DONO}`);
      await c.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${DONO}`);
      await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${DONO}`);
      await c.query(`GRANT REFERENCES ON empresas, usuarios_administrativos, estabelecimentos, pacotes TO ${DONO}`);
      await c.query(`CREATE ROLE ${HERDA} NOLOGIN INHERIT IN ROLE ${DONO}`);
      await c.query(`CREATE ROLE ${SEM} NOLOGIN NOINHERIT IN ROLE ${DONO}`);
      const herdado = await conferir(HERDA);
      assert.equal(herdado.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(herdado));
      const h = herdado.estado as Record<string, unknown>;
      for (const k of ["pode_criar", "dono_092", "dono_093", "dono_094", "referencias_093", "papel_trocado"]) assert.equal(h[k], true, "herdado " + k);
      const semHeranca = await conferir(SEM);
      assert.equal(semHeranca.resultado, "RECUSARIA"); assert.match(semHeranca.motivo!, /SEM_PRIVILEGIO_092 .*DONO/);
    } finally {
      await c.query(`DROP ROLE IF EXISTS ${HERDA}`); await c.query(`DROP ROLE IF EXISTS ${SEM}`);
      await c.query(`REASSIGN OWNED BY ${DONO} TO "${admin.replace(/"/g, '""')}"`);
      await c.query(`DROP OWNED BY ${DONO}`); await c.query(`DROP ROLE ${DONO}`);
    }
    assert.equal((await conferir()).resultado, "PRONTA_PARA_APLICAR", "posse restaurada ao administrador");

    // 3. Vestígio parcial da 093 (só pacote_saloes criada à mão) → recusa na conferência e na aplicação, sem tocar a 092.
    await c.query("CREATE TABLE pacote_saloes (x int)");
    assert.match((await conferir()).motivo!, /APLICACAO_PARCIAL_093/);
    const parcial = await executar();
    assert.equal(parcial.resultado, "FALHA"); assert.match(parcial.falha!.mensagem, /APLICACAO_PARCIAL_093/);
    await c.query("DROP TABLE pacote_saloes");
    assert.deepEqual(await presentes(c), { m092: false, m093: false, m094: false });

    // 4. Erro REAL dentro da 093: outra sessão segura usuarios_administrativos em ACCESS EXCLUSIVE; a 092 (que não a toca)
    //    commita, a FK da 093 espera o lock_timeout de 5 s e o servidor desfaz a transação do arquivo; a 094 não roda.
    const outra = await conectarDescartavel({ travar: false });
    const dirFalha = novoDir();
    let falha: Resultado;
    try {
      await outra.query("BEGIN"); await outra.query("LOCK TABLE usuarios_administrativos IN ACCESS EXCLUSIVE MODE");
      falha = await executar(dirFalha);
    } finally { await outra.query("ROLLBACK").catch(() => {}); await outra.end(); }
    assert.equal(falha.resultado, "FALHA", JSON.stringify(falha)); assert.equal(falha.falha!.etapa, "migration 093");
    assert.match(falha.falha!.mensagem, /lock timeout/); assert.deepEqual(falha.migracoesCommitadas, ["092"]); assert.equal(falha.migracaoIndeterminada, null);
    assert.equal(marcador(dirFalha).etapas.find((x: { nome: string }) => x.nome === "migration 093").commit, "DESFEITA_PELO_SERVIDOR");
    assert.deepEqual(await presentes(c), { m092: true, m093: false, m094: false }, "092 commitada, 093 desfeita, 094 não tentada");
    await assert.rejects(executar(dirFalha), /TENTATIVA_ANTERIOR_REVISAR/, "falha não se repete sozinha");

    // 5. Conexão do aplicador DERRUBADA durante a 094: outra sessão segura fechamentos (ACCESS SHARE numa transação aberta);
    //    o ALTER TABLE da 094 espera, e o backend do aplicador é encerrado antes do lock_timeout → sem resposta: INDETERMINADO.
    renameSync(join(dirFalha, "migration-092-094.json"), join(dirFalha, "migration-092-094.2026-10-23T04-00Z.json"));
    const segura = await conectarDescartavel({ travar: false });
    let derrubada: Resultado;
    try {
      await segura.query("BEGIN"); await segura.query("SELECT 1 FROM fechamentos LIMIT 1");
      const pidSegura = (await segura.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const execucao = executar(dirFalha);
      let terminou: Resultado | null = null;
      void execucao.then((r) => { terminou = r; });
      let alvo: number | null = null;
      for (let i = 0; i < 200 && alvo === null && terminou === null; i++) {
        await new Promise((r) => setTimeout(r, 50));
        // O texto em pg_stat_activity é cortado (track_activity_query_size): o alvo é quem a sessão que segura fechamentos bloqueia.
        alvo = (await c.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()
          AND $1 = ANY (pg_blocking_pids(pid)) LIMIT 1`, [pidSegura])).rows[0]?.pid ?? null;
      }
      assert.ok(alvo, "aplicador esperando o lock da 094; terminou antes com: " + JSON.stringify(terminou));
      await c.query("SELECT pg_terminate_backend($1)", [alvo]);
      derrubada = await execucao;
    } finally { await segura.query("ROLLBACK").catch(() => {}); await segura.end(); }
    assert.equal(derrubada.resultado, "FALHA", JSON.stringify(derrubada)); assert.equal(derrubada.falha!.etapa, "migration 094");
    assert.deepEqual(derrubada.migracoesCommitadas, ["093"]); assert.equal(derrubada.migracaoIndeterminada, "094");
    assert.deepEqual(marcador(dirFalha).tentativasAnteriores, ["migration-092-094.2026-10-23T04-00Z.json"]);
    // Reconciliação: a conferência diz o estado real (aqui, a transação da 094 morreu com o backend).
    assert.deepEqual(await presentes(c), { m092: true, m093: true, m094: false });

    // 6. Uso legítimo da 093 antes da retomada: capacidade 2 num horário e um salão cadastrado. O postcheck de instalação
    //    recusaria (prova de preservação); a conferência usa a integridade e segue PRONTA.
    const empresa = (await c.query<{ id: string }>("SELECT id FROM empresas ORDER BY id LIMIT 1")).rows[0]?.id;
    assert.ok(empresa, "modelo 089 sem empresa: ajustar o caso");
    await c.query("UPDATE configuracao_agenda SET capacidade = 2 WHERE id = (SELECT id FROM configuracao_agenda ORDER BY id LIMIT 1)");
    await c.query("INSERT INTO agenda_saloes (empresa_id, nome) VALUES ($1, 'Salão do ensaio')", [empresa]);
    await assert.rejects(c.query(readFileSync(join(raiz, "database/checks/20261022_093_postcheck.sql"), "utf8")), /093 postcheck: horário existente mudou/);
    const meio = await conferir();
    assert.equal(meio.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(meio));
    assert.deepEqual(meio.checks, { "integridade 092": "PASS", "integridade 093": "PASS", "precheck 094": "PASS" });

    // 7. Retomada (decisão humana): marcador anterior renomeado, nunca apagado; aplica só a 094.
    renameSync(join(dirFalha, "migration-092-094.json"), join(dirFalha, "migration-092-094.2026-10-23T04-30Z.json"));
    const ok = await executar(dirFalha);
    assert.equal(ok.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(ok));
    assert.deepEqual(ok.etapas, ["integridade 092", "integridade 093", ...INSTALA("094")]); assert.deepEqual(ok.migracoesCommitadas, ["094"]);
    assert.deepEqual(await presentes(c), { m092: true, m093: true, m094: true });
    assert.deepEqual(readdirSync(dirFalha).sort(), ["migration-092-094.2026-10-23T04-00Z.json", "migration-092-094.2026-10-23T04-30Z.json", "migration-092-094.json"]);
    assert.deepEqual(marcador(dirFalha).tentativasAnteriores, ["migration-092-094.2026-10-23T04-00Z.json", "migration-092-094.2026-10-23T04-30Z.json"]);
    assert.ok(!JSON.stringify(marcador(dirFalha)).includes("senha-ficticia"));
    await assert.rejects(executar(dirFalha), /TENTATIVA_ANTERIOR_REVISAR/);

    // 8. Uso legítimo da 094: uma festa com salão da mesma empresa e unidade. Postcheck de instalação recusaria; a
    //    conferência segue JA_APLICADA pela integridade.
    //    O modelo 089 não tem festas: empresa, pacote, preço e horário sintéticos do fixture comum (só SQL), e a festa
    //    gravada como na suíte de remarcação da 094, já com o salão (gatilho da 094 confere empresa e unidade).
    const cen = await cenario(c, 0);
    const cfgFesta = await id(c, "SELECT id FROM configuracao_agenda WHERE codigo = $1", [cen.agendaCodigo]);
    const salao = await id(c, "INSERT INTO agenda_saloes (empresa_id, nome) VALUES ($1::uuid, 'Salão da festa do ensaio') RETURNING id", [cen.empresa]);
    await id(c, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_id)
      SELECT $1::date, '10:00', '22:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
             'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $5::uuid FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`,
      [dia(30), cfgFesta, cen.empresa, cen.pacote, salao]);
    await assert.rejects(c.query(readFileSync(join(raiz, "database/checks/20261022_094_postcheck.sql"), "utf8")), /094 postcheck: festa com salão/);
    const usada = await conferir();
    assert.equal(usada.resultado, "JA_APLICADA_INTEGRIDADE_PASS", JSON.stringify(usada));
    assert.deepEqual(usada.checks, { "integridade 092": "PASS", "integridade 093": "PASS", "integridade 094": "PASS" });

    // 9. Adulteração com os marcadores presentes (P3-1): gatilho do salão desligado → estado "completa", integridade recusa.
    await c.query("ALTER TABLE fechamentos DISABLE TRIGGER fechamentos_094_salao_trg");
    try {
      const adulterada = await conferir();
      assert.equal(adulterada.resultado, "FALHA"); assert.match(adulterada.mensagem!, /094 integridade: gatilho/);
    } finally { await c.query("ALTER TABLE fechamentos ENABLE TRIGGER fechamentos_094_salao_trg"); }
    await c.query("ALTER TABLE agenda_saloes DROP CONSTRAINT agenda_saloes_empresa_id_uk");
    assert.match((await conferir()).mensagem ?? "", /093 integridade/, "índice/constraint da 093 removido é detectado");

    // 10. Nova aplicação (outro registro) depois de restaurar o banco à forma íntegra: não há DDL a fazer nem a repetir.
    //     (O caso 9 removeu uma constraint: a recusa da integridade é a resposta correta; nada aqui a recria.)
    const denovo = await executar();
    assert.equal(denovo.resultado, "FALHA"); assert.equal(denovo.falha!.etapa, "integridade 093"); assert.deepEqual(denovo.migracoesCommitadas, []);
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    await encerrarDescartavel(c);
  }
});
