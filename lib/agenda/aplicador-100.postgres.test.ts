import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { cenario, dia, id, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import { aplicadorDeTeste, AVARIAS_108, dadosLegitimos108, escritasEm, medirF2, modelo108 } from "../../scripts/aplicadores-108-test-support.ts";

/**
 * 25/10/2026 — APLICADOR REAL da 100 (scripts/migration-100-staging.cjs) no PostgreSQL descartável, modelo 097 (o
 * estado do staging: 093–097 aplicadas, sem a 098) e modelo 098 (recusa). Única substituição: o cliente do aplicador
 * conecta ao cluster descartável e responde à consulta de identidade como o banco de staging. Casos do parecer do Astra:
 *   1. conferência só leitura → PRONTA, inventário zerado, nada muda;
 *   2. privilégios: sem CREATE/dono → RECUSARIA/FALHA antes de escrever; dono herdado via SET ROLE → PRONTA; sem herança → RECUSARIA;
 *   3. inventário P2-I1: festa de UNIDADE (escopo POR_HORARIO) × festa SEM unidade (mesmo recurso pela 062, escopo sem
 *      configuração) no mesmo horário → 1 par (o inventário antigo, só POR_HORARIO × POR_HORARIO, dava 0);
 *   4. inventário P2-I2: escopos que compartilham recurso com intervalos 0 e 60 → 1 par nas DUAS ordens de ids;
 *      horários configurados diferentes não contam (a 094 já recusava). Ressalva do Astra (P3): origem + hold de remarcação
 *      NÃO é montado aqui — a contagem usa kidmais094_ocupacoes (que inclui o destino) e fechamentos distintos;
 *   5. pares > 0 → conferência RECUSARIA e aplicação FALHA antes da migration (corpo da 094 intacto);
 *   6. erro REAL dentro da migration (lock_timeout com a função travada por outra sessão) → DESFEITA_PELO_SERVIDOR;
 *   7. conexão do aplicador DERRUBADA durante a migration → INDETERMINADO; a conferência mostra o estado real;
 *   8. aplicação → APLICADA_POSTCHECK_PASS; o CONFERIR da 092–094 passa com a integridade da 094 após a 100;
 *   9. nova aplicação só confere; corpo adulterado → 100 RECUSARIA (divergente) e a 092–094 recusa pela integridade original.
 * Plano E4 (E4-6), modelo 108: com o corpo da 108 e a prova única "108 íntegra", CONFERIR e APLICAR =
 * JA_APLICADA_SUBSTITUIDA_108 (sucesso) sem reaplicar a 100 (corpo da 108 intacto, nenhum DDL/DML enviado), também com
 * dados legítimos; avarias da 108 → RECUSARIA/FALHA com o motivo da prova.
 * As ocupações de inventário entram com session_replication_role = replica (sem as validações da agenda: o que se prova
 * é a LEITURA do inventário sobre ocupações que a 094 aceitava) e saem do mesmo jeito ao fim de cada caso.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
type Resultado = { resultado: string; motivo?: string; mensagem?: string; falha?: { etapa: string; mensagem: string }; etapas?: string[];
  estado?: Record<string, unknown>; inventario?: Record<string, number>; checks?: Record<string, string>; commit?: string | null };
type Aplicador = { SQL_IDENTIDADE: string; conferir(o: unknown): Promise<Resultado>; executar(o: unknown): Promise<Resultado> };
const stg = exigir(join(raiz, "scripts/migration-100-staging.cjs")) as Aplicador;
const stg094 = exigir(join(raiz, "scripts/migration-092-094-staging.cjs")) as Aplicador;
const { SQL_INVENTARIO } = exigir(join(raiz, "scripts/migration-100-comum.cjs")) as { SQL_INVENTARIO: string };
const { CORPO_CONFLITO_094, CORPO_CONFLITO_100 } = exigir(join(raiz, "scripts/migration-092-094-comum.cjs")) as { CORPO_CONFLITO_094: string; CORPO_CONFLITO_100: string };
// Configuração FICTÍCIA: só satisfaz a trava de alvo; a URL nunca é usada (o cliente abaixo a ignora).
const ENV_STG = { RENDER: "true", RENDER_SERVICE_ID: "srv-daif418ae00c73e8k2gg", KIDMAIS_DEPLOY_ENV: "staging", DATABASE_SSL: "false",
  DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91" };
const IDENTIDADE = { db: "kidmais_staging_1z91", tls: false, servidor_privado: true };
const FUNCAO = "kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)";
const PAPEL = "kidmais_teste_aplicador_100", DONO = "kidmais_teste_dono_100", HERDA = "kidmais_teste_herda_100", SEM = "kidmais_teste_sem_heranca_100";
const D = dia(45);
// Inventário ANTERIOR ao parecer (só POR_HORARIO × POR_HORARIO, intervalo pelo menor id): prova de que o caso 3/4 o pegaria.
const INVENTARIO_ANTIGO = `WITH um AS (SELECT empresa_id, estabelecimento_id, intervalo_minimo_minutos AS intervalo FROM agenda_escopo_config WHERE capacidade_tipo = 'POR_HORARIO'),
  o AS (SELECT o.fechamento_id, o.data, o.empresa_id, o.estabelecimento_id, o.configuracao_agenda_id, um.intervalo,
          (extract(epoch FROM o.horario_inicio) / 60)::integer AS ini, (extract(epoch FROM o.horario_fim) / 60)::integer AS fim
        FROM kidmais094_ocupacoes((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date, 'infinity'::date) o
        JOIN um ON um.empresa_id = o.empresa_id AND um.estabelecimento_id IS NOT DISTINCT FROM o.estabelecimento_id)
SELECT count(*)::int AS n FROM o x JOIN o y ON y.data = x.data AND y.fechamento_id > x.fechamento_id AND y.configuracao_agenda_id = x.configuracao_agenda_id
  AND kidmais062_mesmo_recurso(x.empresa_id, x.estabelecimento_id, y.empresa_id, y.estabelecimento_id)
 WHERE x.ini < y.fim + x.intervalo AND x.fim > y.ini - x.intervalo`;

function clienteDescartavel(cfg: { papel?: string } = {}) {
  return class {
    c: Client | null = null;
    on() {}
    async connect() {
      this.c = await conectarDescartavel({ travar: false });
      this.c.on("error", () => undefined);
      if (cfg.papel) await this.c.query(`SET ROLE ${cfg.papel}`);
    }
    async query(sql: string) { return sql === stg.SQL_IDENTIDADE || sql === stg094.SQL_IDENTIDADE ? { rows: [IDENTIDADE] } : this.c!.query(sql); }
    async end() { if (this.c) await this.c.end(); }
  };
}

test("aplicador 100 real: modelos 097 (aplica) e 098 (recusa); privilégios, inventário (P2-I1/P2-I2), falhas reais, CONFERIR da 092–094", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const dirs: string[] = [];
  const novoDir = () => { const d = mkdtempSync(join(tmpdir(), "aplicador-100-")); dirs.push(d); return d; };
  const BACKUP = "export 2026-10-25T12:00Z teste";
  const executar = (dir = novoDir(), papel?: string) => stg.executar({ env: ENV_STG, backup: BACKUP, dir, raiz, disco: () => {}, Client: clienteDescartavel({ papel }) });
  const conferir = (papel?: string) => stg.conferir({ env: ENV_STG, raiz, Client: clienteDescartavel({ papel }) });
  const corpo = async () => (await c.query<{ h: string | null }>(`SELECT encode(sha256(convert_to(replace(prosrc, E'\\r', ''), 'UTF8')), 'hex') AS h
    FROM pg_proc WHERE oid = to_regprocedure('public.${FUNCAO}')`)).rows[0]?.h ?? null;
  const pares = async (sql = SQL_INVENTARIO) => (await c.query<{ pares_mesmo_horario?: number; n?: number }>(sql)).rows[0];
  try {
    if (await modelo108(c)) { t.skip("modelo 108: coberto pelo teste da 100 × 108 abaixo"); return; }
    const com098 = (await c.query<{ ok: boolean }>(`SELECT to_regprocedure('public.kidmais098_hoje()') IS NOT NULL AS ok`)).rows[0].ok;
    if (com098) {
      // Modelo 098: corpo diferente do da 094 → RECUSARIA (divergente), sem escrever nada.
      const antes = await corpo();
      const r = await conferir();
      assert.equal(r.resultado, "RECUSARIA", JSON.stringify(r)); assert.match(r.motivo!, /CORPO_DIVERGENTE_100/);
      const e = await executar();
      assert.equal(e.resultado, "FALHA"); assert.match(e.falha!.mensagem, /CORPO_DIVERGENTE_100/); assert.equal(e.commit, null);
      assert.equal(await corpo(), antes);
      return;
    }
    assert.equal(await corpo(), CORPO_CONFLITO_094, "modelo 097: corpo da 094");

    // 1. Conferência só leitura.
    const conf = await conferir();
    assert.equal(conf.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(conf));
    assert.deepEqual(conf.checks, { "precheck 100": "PASS", "postcheck 100": "APOS_100", "integridade 094 apos 100": "APOS_100" });
    assert.equal(conf.inventario!.pares_mesmo_horario, 0);
    for (const k of ["d100", "dono", "pode_criar", "linguagem", "tipos"]) assert.equal((conf.estado as Record<string, unknown>)[k], true, k);
    assert.equal(await corpo(), CORPO_CONFLITO_094);

    // 2a. Papel sem privilégios (só USAGE/SELECT) e depois com CREATE, ainda sem ser dono.
    await c.query(`DROP ROLE IF EXISTS ${PAPEL}`);
    await c.query(`CREATE ROLE ${PAPEL} NOLOGIN`);
    try {
      await c.query(`GRANT USAGE ON SCHEMA public TO ${PAPEL}`);
      await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${PAPEL}`);
      const r1 = await conferir(PAPEL);
      assert.equal(r1.resultado, "RECUSARIA", JSON.stringify(r1)); assert.match(r1.motivo!, /SEM_PRIVILEGIO_100 DONO CREATE$/);
      await c.query(`GRANT CREATE ON SCHEMA public TO ${PAPEL}`);
      const r2 = await conferir(PAPEL);
      assert.equal(r2.resultado, "RECUSARIA", JSON.stringify(r2)); assert.match(r2.motivo!, /SEM_PRIVILEGIO_100 DONO$/);
      const r3 = await executar(novoDir(), PAPEL);
      assert.equal(r3.resultado, "FALHA"); assert.match(r3.falha!.mensagem, /SEM_PRIVILEGIO_100 DONO/); assert.equal(r3.commit, null);
      assert.equal(await corpo(), CORPO_CONFLITO_094);
    } finally {
      await c.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${PAPEL}`);
      await c.query(`REVOKE ALL ON SCHEMA public FROM ${PAPEL}`);
      await c.query(`DROP ROLE ${PAPEL}`);
    }
    // 2b. Dono herdado via SET ROLE (como no Render) → PRONTA; membro sem herança → RECUSARIA. A posse volta no fim.
    const admin = (await c.query<{ u: string }>("SELECT current_user AS u")).rows[0].u;
    await c.query(`CREATE ROLE ${DONO} NOLOGIN`);
    try {
      await c.query(`ALTER FUNCTION ${FUNCAO} OWNER TO ${DONO}`);
      await c.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${DONO}`);
      await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${DONO}`);
      await c.query(`CREATE ROLE ${HERDA} NOLOGIN INHERIT IN ROLE ${DONO}`);
      await c.query(`CREATE ROLE ${SEM} NOLOGIN NOINHERIT IN ROLE ${DONO}`);
      const herdado = await conferir(HERDA);
      assert.equal(herdado.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(herdado));
      assert.equal((herdado.estado as Record<string, unknown>).papel_trocado, true);
      const semHeranca = await conferir(SEM);
      assert.equal(semHeranca.resultado, "RECUSARIA"); assert.match(semHeranca.motivo!, /SEM_PRIVILEGIO_100 .*DONO|SEM_PRIVILEGIO_100 DONO/);
    } finally {
      await c.query(`DROP ROLE IF EXISTS ${HERDA}`); await c.query(`DROP ROLE IF EXISTS ${SEM}`);
      await c.query(`REASSIGN OWNED BY ${DONO} TO "${admin.replace(/"/g, '""')}"`);
      await c.query(`DROP OWNED BY ${DONO}`); await c.query(`DROP ROLE ${DONO}`);
    }
    assert.equal((await conferir()).resultado, "PRONTA_PARA_APLICAR", "posse restaurada");

    // Cenário de inventário: empresa com uma unidade; horário da empresa (sem unidade) usado pelas duas festas.
    const cen = await cenario(c, 1);
    const unidade = cen.unidade!;
    const horario = await id(c, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
      ordem_exibicao, empresa_id, capacidade) VALUES ($1, $1, '10:00', '20:00', 0, 30, 1, $2::uuid, 2) RETURNING id`, [`INV_${Date.now()}`, cen.empresa]);
    const escopo = (estab: string | null, intervalo: number) => c.query(`INSERT INTO agenda_escopo_config (empresa_id, estabelecimento_id, modo, capacidade_tipo,
      limite_festas_dia, intervalo_minimo_minutos, configurado_por) VALUES ($1::uuid, $2::uuid, 'FIXO', 'POR_HORARIO', NULL, $3, $4::uuid)`, [cen.empresa, estab, intervalo, cen.usuario]);
    const semEscopos = () => c.query(`DELETE FROM agenda_escopo_config WHERE empresa_id = $1::uuid`, [cen.empresa]);
    const criadas: string[] = [];
    async function ocupacao(c0: Cenario, fid: string, estab: string | null, ini: string, fim: string, cfg = horario) {
      await c.query("SET session_replication_role = replica");
      try {
        await c.query(`INSERT INTO fechamentos (id, data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, estabelecimento_id, pacote_id, tabela_preco_id,
            preco_pacote_id, categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela,
            origem_fechamento, cliente_id, status)
          SELECT $1::uuid, $2::date, $3::time, $4::time, $5::uuid, $6::uuid, $7::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
                 'ATENDIMENTO_KIDMAIS', NULL, 'CONFIRMADO' FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $8::uuid LIMIT 1`,
          [fid, D, ini, fim, cfg, c0.empresa, estab, c0.pacote]);
      } finally { await c.query("SET session_replication_role = origin"); }
      criadas.push(fid);
    }
    async function limparOcupacoes() {
      await c.query("SET session_replication_role = replica");
      try { await c.query(`DELETE FROM fechamentos WHERE id = ANY($1::uuid[])`, [criadas.splice(0)]); } finally { await c.query("SET session_replication_role = origin"); }
    }
    const idsOrdenados = () => { const a = [randomUUID(), randomUUID()].sort(); return { menor: a[0], maior: a[1] }; };

    // 3. P2-I1: festa da UNIDADE (escopo POR_HORARIO) × festa SEM unidade (escopo da empresa sem configuração), mesmo horário.
    await escopo(unidade, 0);
    {
      const { menor, maior } = idsOrdenados();
      await ocupacao(cen, menor, unidade, "15:00", "19:00");
      await ocupacao(cen, maior, null, "15:00", "19:00");
      assert.equal((await pares()).pares_mesmo_horario, 1, "unidade nula compartilha o recurso: 1 par");
      assert.equal((await pares(INVENTARIO_ANTIGO)).n, 0, "o inventário antigo não via o par");
      // 5. Pares > 0: conferência RECUSARIA e aplicação FALHA antes da migration.
      const rec = await conferir();
      assert.equal(rec.resultado, "RECUSARIA"); assert.match(rec.motivo!, /CONFLITOS_PREEXISTENTES_100 1/);
      const f = await executar();
      assert.equal(f.resultado, "FALHA"); assert.match(f.falha!.mensagem, /CONFLITOS_PREEXISTENTES_100 1/); assert.equal(f.commit, null);
      assert.equal(await corpo(), CORPO_CONFLITO_094, "nada aplicado");
      await limparOcupacoes();
    }
    await semEscopos();

    // 4. P2-I2: escopos que compartilham recurso com intervalos 0 (unidade) e 60 (empresa); 13–15 × 15:30–17:30 só conflita
    //    pelo intervalo de 60 — nas DUAS ordens de ids.
    await escopo(unidade, 0); await escopo(null, 60);
    for (const unidadeMenor of [true, false]) {
      const { menor, maior } = idsOrdenados();
      await ocupacao(cen, unidadeMenor ? menor : maior, unidade, "13:00", "15:00");
      await ocupacao(cen, unidadeMenor ? maior : menor, null, "15:30", "17:30");
      assert.equal((await pares()).pares_mesmo_horario, 1, `intervalo do lado afetado, ids ${unidadeMenor ? "unidade menor" : "unidade maior"}`);
      await limparOcupacoes();
    }
    // Controle: horários configurados diferentes não contam (a 094 já recusava).
    {
      const outro = await id(c, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
        ordem_exibicao, empresa_id, capacidade) VALUES ($1, $1, '10:00', '20:00', 0, 30, 2, $2::uuid, 2) RETURNING id`, [`INV2_${Date.now()}`, cen.empresa]);
      await ocupacao(cen, randomUUID(), unidade, "15:00", "19:00");
      await ocupacao(cen, randomUUID(), null, "15:00", "19:00", outro);
      assert.equal((await pares()).pares_mesmo_horario, 0, "horários configurados diferentes");
      await limparOcupacoes();
    }
    await semEscopos();
    assert.equal((await conferir()).resultado, "PRONTA_PARA_APLICAR", "inventário limpo de novo");

    // 6. Erro REAL dentro da migration: outra sessão altera a função sem commitar (segura a linha de pg_proc); o CREATE OR
    //    REPLACE espera o lock_timeout de 5 s e o servidor desfaz a transação do arquivo.
    const outra = await conectarDescartavel({ travar: false });
    let desfeita: Resultado;
    try {
      await outra.query("BEGIN"); await outra.query(`ALTER FUNCTION ${FUNCAO} COST 101`);
      desfeita = await executar();
    } finally { await outra.query("ROLLBACK").catch(() => {}); await outra.end(); }
    assert.equal(desfeita.resultado, "FALHA", JSON.stringify(desfeita)); assert.equal(desfeita.falha!.etapa, "migration 100");
    assert.match(desfeita.falha!.mensagem, /lock timeout/); assert.equal(desfeita.commit, "DESFEITA_PELO_SERVIDOR");
    assert.equal(await corpo(), CORPO_CONFLITO_094);

    // 7. Conexão do aplicador DERRUBADA enquanto a migration espera a função: INDETERMINADO; a conferência diz o estado real.
    const segura = await conectarDescartavel({ travar: false });
    let derrubada: Resultado;
    try {
      await segura.query("BEGIN"); await segura.query(`ALTER FUNCTION ${FUNCAO} COST 102`);
      const pidSegura = (await segura.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const execucao = executar();
      let terminou: Resultado | null = null;
      void execucao.then((r) => { terminou = r; });
      let alvo: number | null = null;
      for (let i = 0; i < 80 && alvo === null && terminou === null; i++) {
        await new Promise((r) => setTimeout(r, 50));
        alvo = (await c.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()
          AND $1 = ANY (pg_blocking_pids(pid)) LIMIT 1`, [pidSegura])).rows[0]?.pid ?? null;
      }
      assert.ok(alvo, "aplicador esperando a função; terminou antes com: " + JSON.stringify(terminou));
      await c.query("SELECT pg_terminate_backend($1)", [alvo]);
      derrubada = await execucao;
    } finally { await segura.query("ROLLBACK").catch(() => {}); await segura.end(); }
    assert.equal(derrubada.resultado, "FALHA", JSON.stringify(derrubada)); assert.equal(derrubada.commit, "INDETERMINADO");
    assert.equal((await conferir()).resultado, "PRONTA_PARA_APLICAR", "reconciliação: a transação morreu com o backend");

    // 8. Aplicação → APLICADA; o CONFERIR da 092–094 passa com a integridade da 094 após a 100 (real).
    const ok = await executar();
    assert.equal(ok.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(ok));
    assert.deepEqual(ok.etapas, ["precheck 100", "migration 100", "postcheck 100", "integridade 094 apos 100"]); assert.equal(ok.commit, "CONFIRMADO");
    assert.equal(await corpo(), CORPO_CONFLITO_100);
    const conf094 = await stg094.conferir({ env: ENV_STG, raiz, Client: clienteDescartavel() });
    assert.equal(conf094.resultado, "JA_APLICADA_INTEGRIDADE_PASS", JSON.stringify(conf094));
    assert.equal(conf094.checks!["integridade 094"], "PASS_CORPO_100");

    // 9. Nova aplicação: só confere. Corpo adulterado: a 100 recusa (divergente) e a 092–094 recusa pela integridade original.
    const denovo = await executar();
    assert.equal(denovo.resultado, "JA_APLICADA_INTEGRIDADE_PASS"); assert.deepEqual(denovo.etapas, ["postcheck 100", "integridade 094 apos 100"]); assert.equal(denovo.commit, null);
    const sql100 = readFileSync(join(raiz, "database/migrations/20261025_100_agenda_um_salao.sql"), "utf8").replace(/\r\n/g, "\n");
    const criar = sql100.slice(sql100.indexOf("CREATE OR REPLACE FUNCTION"), sql100.indexOf("$$;", sql100.indexOf("CREATE OR REPLACE FUNCTION")) + 3);
    await c.query(criar.replace("BEGIN\n", "BEGIN\n  -- adulterado no ensaio\n"));
    try {
      const div = await conferir();
      assert.equal(div.resultado, "RECUSARIA"); assert.match(div.motivo!, /CORPO_DIVERGENTE_100/);
      const div094 = await stg094.conferir({ env: ENV_STG, raiz, Client: clienteDescartavel() });
      // Plano E4 (E4-6): corpo desconhecido na regra de conflito = recusa nomeada, sem rodar integridade nenhuma.
      assert.equal(div094.resultado, "RECUSARIA"); assert.match(div094.motivo!, /^CORPO_CONFLITO_DESCONHECIDO_094$/);
    } finally { await c.query(criar); }
    assert.equal(await corpo(), CORPO_CONFLITO_100, "corpo da 100 restaurado");
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    await encerrarDescartavel(c);
  }
});

function clienteRegistrado(registro: string[]) {
  return class {
    c: Client | null = null;
    on() {}
    async connect() { this.c = await conectarDescartavel({ travar: false }); this.c.on("error", () => undefined); }
    async query(sql: string) { registro.push(sql); return sql === stg.SQL_IDENTIDADE ? { rows: [IDENTIDADE] } : this.c!.query(sql); }
    async end() { if (this.c) await this.c.end(); }
  };
}

test("aplicador 100 no modelo 108: JA_APLICADA_SUBSTITUIDA_108 sem reaplicar (com dados legítimos); avarias da 108 recusam", { timeout: 900_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const dirs: string[] = [];
  const novoDir = () => { const d = mkdtempSync(join(tmpdir(), "aplicador-100-108-")); dirs.push(d); return d; };
  const corpo = async () => (await c.query<{ h: string | null }>(`SELECT encode(sha256(convert_to(replace(prosrc, E'\\r', ''), 'UTF8')), 'hex') AS h
    FROM pg_proc WHERE oid = to_regprocedure('public.${FUNCAO}')`)).rows[0]?.h ?? null;
  const registro: string[] = [];
  // Aplicador de teste (aceita o F2 medido); o de staging recusa o override (provado sem banco em scripts/migration-100.test.cjs).
  const teste = aplicadorDeTeste<Aplicador>("scripts/migration-100-comum.cjs", "scripts/migration-100-staging.cjs");
  let env: Record<string, string> = ENV_STG;
  const conferir = () => teste.conferir({ env, raiz, Client: clienteRegistrado(registro) });
  const executar = () => teste.executar({ env, backup: "PITR 2026-10-29T12:00Z teste", dir: novoDir(), raiz, disco: () => {}, Client: clienteRegistrado(registro) });
  const CHECKS = { "prova 108": "INTEGRA", "integridade 094 apos 108": "PASS" };
  try {
    if (!(await modelo108(c))) { t.skip("só no modelo 108"); return; }
    const { CORPO_CONFLITO_108 } = exigir(join(raiz, "scripts/migration-092-094-comum.cjs")) as { CORPO_CONFLITO_108: string };
    assert.equal(await corpo(), CORPO_CONFLITO_108, "modelo 108: corpo da 108");
    const f2 = await medirF2(c);
    env = { ...ENV_STG, ...f2.env };
    try {
      for (const fase of ["limpo", "com dados legítimos"]) {
        if (fase !== "limpo") await dadosLegitimos108(c);
        registro.length = 0;
        const conf = await conferir();
        assert.equal(conf.resultado, "JA_APLICADA_SUBSTITUIDA_108", fase + ": " + JSON.stringify(conf)); assert.deepEqual(conf.checks, CHECKS);
        assert.equal(conf.inventario, undefined, "sem inventário");
        const e = await executar();
        assert.equal(e.resultado, "JA_APLICADA_SUBSTITUIDA_108", fase + ": " + JSON.stringify(e)); assert.equal(e.commit, null);
        assert.deepEqual(escritasEm(registro), [], fase + ": nenhum DDL/DML enviado (a 100 nunca é reaplicada sobre a 108)");
        assert.equal(await corpo(), CORPO_CONFLITO_108, fase + ": corpo da 108 intacto");
      }
      for (const avaria of AVARIAS_108) {
        await c.query(avaria.aplicar);
        try {
          const r = await conferir();
          assert.equal(r.resultado, "RECUSARIA", avaria.nome + ": " + JSON.stringify(r));
          assert.match(r.motivo!, /^SUBSTITUIDA_108_NAO_INTEGRA /); assert.match(r.motivo!, avaria.motivo, avaria.nome);
          registro.length = 0;
          const e = await executar();
          assert.equal(e.resultado, "FALHA", avaria.nome); assert.match(e.falha!.mensagem, avaria.motivo, avaria.nome); assert.equal(e.commit, null);
          assert.deepEqual(escritasEm(registro), [], avaria.nome);
        } finally { await c.query(avaria.desfazer); }
        assert.equal((await conferir()).resultado, "JA_APLICADA_SUBSTITUIDA_108", "restaurado: " + avaria.nome);
      }
    } finally { env = ENV_STG; }
    const recusado = await stg.conferir({ env: { ...ENV_STG, ...f2.env }, raiz, Client: clienteRegistrado(registro) });
    assert.equal(recusado.resultado, "RECUSARIA"); assert.match(recusado.motivo!, /^RETRATOS_DE_TESTE_RECUSADOS/);
    assert.equal(await corpo(), CORPO_CONFLITO_108);
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    await encerrarDescartavel(c);
  }
});
