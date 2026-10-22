import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";

/**
 * Créditos de IA (22/10/2026), derivado do teste dos aplicadores da 089 — os APLICADORES REAIS da 090 (scripts/migration-090-staging.cjs e -production.cjs) no
 * PostgreSQL descartável, modelo 089 (090 ausente). Só pelo check:v1:postgres com KIDMAIS_POSTGRES_DESCARTAVEL.
 * Única substituição: o cliente do aplicador conecta ao cluster descartável (identidade provada por conectarDescartavel)
 * e responde à consulta de identidade como o banco do ambiente responderia. Trava de alvo, identidade e marcador são
 * provados sem banco (scripts/migration-090.test.cjs); aqui, as fases com SQL REAL:
 *   1. conferência só leitura (staging e produção) → PRONTA, nada criado;
 *   2. papel sem CREATE/REFERENCES (has_*_privilege reais) → conferência RECUSARIA e aplicação FALHA antes de escrever;
 *   3. vestígio parcial (só a função da guarda criada à mão) → recusa;
 *   4. falha REAL dentro da 090 (lock_timeout com tráfego simulado) → FALHA no marcador, nada da 090 fica, sem repetição;
 *   5. aplicação (produção) → APLICADA_POSTCHECK_PASS, objetos e contagens; marcador CONCLUIDA; repetição recusada;
 *   6. nova conferência e nova aplicação (outro registro) só conferem; o down fica fora do aplicador.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
type Resultado = { resultado: string; motivo?: string; falha?: { etapa: string; mensagem: string }; etapas?: string[]; estado?: Record<string, unknown>;
  estadoDepois?: Record<string, unknown>; contagensDepois?: Record<string, number>; marcador?: string; migracaoCommitada?: boolean };
type Aplicador = { SQL_IDENTIDADE: string; conferir(o: unknown): Promise<Resultado>; executar(o: unknown): Promise<Resultado> };
const stg = exigir(join(raiz, "scripts/migration-090-staging.cjs")) as Aplicador;
const prod = exigir(join(raiz, "scripts/migration-090-production.cjs")) as Aplicador;
// Configurações FICTÍCIAS: só satisfazem a trava de alvo; a URL nunca é usada (o cliente abaixo a ignora).
const ENV_STG = { RENDER: "true", RENDER_SERVICE_ID: "srv-daif418ae00c73e8k2gg", KIDMAIS_DEPLOY_ENV: "staging", DATABASE_SSL: "false",
  DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91" };
const ENV_PROD = { RENDER: "true", RENDER_SERVICE_ID: "srv-dak77m2d0e5s73b8rkkg", KIDMAIS_DEPLOY_ENV: "production", DATABASE_SSL: "true",
  DATABASE_SSL_REJECT_UNAUTHORIZED: "false", DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-dak750gae00c73fudmg0-a/kidmais_production" };
const IDENTIDADE = new Map([[stg.SQL_IDENTIDADE, { db: "kidmais_staging_1z91", tls: false, servidor_privado: true }],
  [prod.SQL_IDENTIDADE, { db: "kidmais_production", tls: true, tls_versao: "TLSv1.3", servidor_privado: true }]]);
const PAPEL = "kidmais_teste_aplicador_090";

function clienteDescartavel(cfg: { papel?: string } = {}) {
  return class {
    c: Client | null = null;
    on() {}
    async connect() { this.c = await conectarDescartavel({ travar: false }); if (cfg.papel) await this.c.query(`SET ROLE ${cfg.papel}`); }
    async query(sql: string) { const id = IDENTIDADE.get(sql); return id ? { rows: [id] } : this.c!.query(sql); }
    async end() { if (this.c) await this.c.end(); }
  };
}
const objetos = async (c: Client) => (await c.query<Record<string, boolean>>(`SELECT to_regclass('public.ia_credito_carteiras') IS NOT NULL AS tabela,
  to_regprocedure('public.kidmais_090_guarda()') IS NOT NULL AS funcao, to_regclass('public.ia_credito_cobrancas_canonica_uk') IS NOT NULL AS indice`)).rows[0];
const NADA = { tabela: false, funcao: false, indice: false };

test("aplicadores 090 reais no modelo 089: conferência, privilégios, parcial, falha real, aplicação, anti-repetição", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const dirs: string[] = [];
  const novoDir = () => { const d = mkdtempSync(join(tmpdir(), "aplicador-090-")); dirs.push(d); return d; };
  const BACKUP = "export 2026-10-22T03:00Z teste";
  try {
    assert.deepEqual(await objetos(c), NADA, "modelo 089: 090 ausente");
    // 1. Conferência só leitura nos dois ambientes.
    for (const [m, env] of [[stg, ENV_STG], [prod, ENV_PROD]] as const) {
      const conf = await m.conferir({ env, raiz, Client: clienteDescartavel() });
      assert.equal(conf.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(conf));
      assert.deepEqual(conf.estado, { dependencias: true, usuarios: true, m090: "ausente", pode_criar: true, pode_referenciar: true, papel_trocado: false });
    }
    assert.deepEqual(await objetos(c), NADA);

    // 2. Papel sem privilégios: só USAGE e SELECT; depois com CREATE mas sem REFERENCES.
    await c.query(`DROP ROLE IF EXISTS ${PAPEL}`);
    await c.query(`CREATE ROLE ${PAPEL} NOLOGIN`);
    try {
      await c.query(`GRANT USAGE ON SCHEMA public TO ${PAPEL}`);
      await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${PAPEL}`);
      const r1 = await prod.conferir({ env: ENV_PROD, raiz, Client: clienteDescartavel({ papel: PAPEL }) });
      assert.equal(r1.resultado, "RECUSARIA"); assert.match(r1.motivo!, /SEM_PRIVILEGIO_090 CREATE REFERENCES/);
      assert.equal((r1.estado as { papel_trocado: boolean }).papel_trocado, true, "SET ROLE visto como papel trocado (sem nome)");
      await c.query(`GRANT CREATE ON SCHEMA public TO ${PAPEL}`);
      const r2 = await stg.conferir({ env: ENV_STG, raiz, Client: clienteDescartavel({ papel: PAPEL }) });
      assert.equal(r2.resultado, "RECUSARIA"); assert.match(r2.motivo!, /SEM_PRIVILEGIO_090 REFERENCES/);
      const dir = novoDir();
      const r3 = await prod.executar({ env: ENV_PROD, backup: BACKUP, dir, raiz, disco: () => {}, Client: clienteDescartavel({ papel: PAPEL }) });
      assert.equal(r3.resultado, "FALHA"); assert.match(r3.falha!.mensagem, /SEM_PRIVILEGIO_090/); assert.equal(r3.migracaoCommitada, false);
      assert.equal(JSON.parse(readFileSync(join(dir, "migration-090.json"), "utf8")).situacao, "FALHA");
      assert.deepEqual(await objetos(c), NADA);
    } finally {
      await c.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${PAPEL}`);
      await c.query(`REVOKE ALL ON SCHEMA public FROM ${PAPEL}`);
      await c.query(`DROP ROLE ${PAPEL}`);
    }

    // 3. Vestígio parcial: só a função da 090 criada à mão → recusa (conferência e aplicação).
    await c.query("CREATE FUNCTION kidmais_090_guarda() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$");
    assert.match((await stg.conferir({ env: ENV_STG, raiz, Client: clienteDescartavel() })).motivo!, /APLICACAO_PARCIAL_090/);
    const parcial = await stg.executar({ env: ENV_STG, backup: BACKUP, dir: novoDir(), raiz, disco: () => {}, Client: clienteDescartavel() });
    assert.equal(parcial.resultado, "FALHA"); assert.match(parcial.falha!.mensagem, /APLICACAO_PARCIAL_090/);
    await c.query("DROP FUNCTION kidmais_090_guarda()");

    // 4. Falha REAL dentro da 090 (tráfego): outra sessão segura usuarios_administrativos em ACCESS EXCLUSIVE; a FK da 090
    //    espera o lock_timeout de 5 s e a transação do arquivo é desfeita por inteiro. Estado e precheck não tocam a tabela.
    const outra = await conectarDescartavel({ travar: false });
    const dirFalha = novoDir();
    let falha: Resultado;
    try {
      await outra.query("BEGIN"); await outra.query("LOCK TABLE usuarios_administrativos IN ACCESS EXCLUSIVE MODE");
      falha = await prod.executar({ env: ENV_PROD, backup: BACKUP, dir: dirFalha, raiz, disco: () => {}, Client: clienteDescartavel() });
    } finally { await outra.query("ROLLBACK").catch(() => {}); await outra.end(); }
    assert.equal(falha.resultado, "FALHA", JSON.stringify(falha)); assert.equal(falha.falha!.etapa, "migration 090");
    assert.match(falha.falha!.mensagem, /lock timeout/); assert.equal(falha.migracaoCommitada, false);
    assert.deepEqual(await objetos(c), NADA, "a transação da 090 foi desfeita por inteiro");
    const repetir = prod.executar({ env: ENV_PROD, backup: BACKUP, dir: dirFalha, raiz, disco: () => {}, Client: clienteDescartavel() });
    await assert.rejects(repetir, /TENTATIVA_ANTERIOR_REVISAR/, "falha não se repete sozinha");

    // 5. Aplicação real (produção): precheck → 090 → postcheck; marcador CONCLUIDA; repetição recusada.
    const dir = novoDir();
    const ok = await prod.executar({ env: ENV_PROD, backup: BACKUP, dir, raiz, disco: () => {}, Client: clienteDescartavel() });
    assert.equal(ok.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(ok));
    assert.deepEqual(ok.etapas, ["precheck 090", "migration 090", "postcheck 090"]);
    assert.equal((ok.estadoDepois as { m090: string }).m090, "completa"); assert.equal(ok.contagensDepois!.pedidos, 0);
    assert.deepEqual(await objetos(c), { tabela: true, funcao: true, indice: true });
    assert.deepEqual(readdirSync(dir), ["migration-090.json"]);
    const marcador = JSON.parse(readFileSync(join(dir, "migration-090.json"), "utf8"));
    assert.equal(marcador.situacao, "CONCLUIDA"); assert.equal(marcador.backup, BACKUP); assert.ok(!JSON.stringify(marcador).includes("senha-ficticia"));
    await assert.rejects(prod.executar({ env: ENV_PROD, backup: BACKUP, dir, raiz, disco: () => {}, Client: clienteDescartavel() }), /TENTATIVA_ANTERIOR_REVISAR/);

    // 6. Depois: conferência → JA_APLICADA; aplicação com outro registro só confere (postcheck), sem DDL.
    for (const [m, env] of [[stg, ENV_STG], [prod, ENV_PROD]] as const)
      assert.equal((await m.conferir({ env, raiz, Client: clienteDescartavel() })).resultado, "JA_APLICADA_POSTCHECK_PASS");
    const denovo = await stg.executar({ env: ENV_STG, backup: BACKUP, dir: novoDir(), raiz, disco: () => {}, Client: clienteDescartavel() });
    assert.equal(denovo.resultado, "JA_APLICADA_POSTCHECK_PASS"); assert.deepEqual(denovo.etapas, ["postcheck 090"]);
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await encerrarDescartavel(c);
  }
});
