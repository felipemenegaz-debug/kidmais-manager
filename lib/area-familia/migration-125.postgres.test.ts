import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";

/**
 * 125 (ações da área "Minha festa", F3) — ciclo da migration no PostgreSQL DESCARTÁVEL recriado do modelo 125 (sem
 * linhas da 125): precheck e up repetido recusam com a 125 instalada sem alterar nada; down COMMITA, o CHECK dos tipos
 * de evento volta ao da 123 e o precheck passa; up de novo reproduz o MESMO catálogo e o postcheck passa. O precheck
 * recusa a ausência da 123 e um CHECK de tipos fora do formato da 123. A recusa do down COM dados fica na suíte das
 * ações (acoes.postgres.test.ts), que tem festa real.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
const UP = readFileSync("database/migrations/20261115_125_area_familia_acoes.sql", "utf8");
const DOWN = readFileSync("database/rollback/20261115_125_area_familia_acoes_down.sql", "utf8");
const PRE = readFileSync("database/checks/20261115_125_precheck.sql", "utf8");
const POS = readFileSync("database/checks/20261115_125_postcheck.sql", "utf8");
const semTransacao = (sql: string) => sql.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "");

let a: Client;
let com125 = false;
test.before(async () => {
  if (!opt()) return;
  a = await conectarDescartavel();
  com125 = (await a.query("SELECT to_regclass('public.festa_pendencias_familia') IS NOT NULL AS ok")).rows[0].ok;
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

async function catalogo() {
  const q = async (sql: string) => (await a.query<{ x: string }>(sql)).rows.map((r) => r.x);
  return {
    tabelas: await q(`SELECT c.relname || ':' || c.relkind::text AS x FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','S','p') ORDER BY 1`),
    colunas: await q(`SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') AS x FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`),
    constraints: await q(`SELECT conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid) || ':' || convalidated AS x FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1`),
    gatilhos: await q(`SELECT tgrelid::regclass::text || '.' || tgname || ':' || tgenabled::text || ':' || pg_get_triggerdef(oid) AS x FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`),
    indices: await q(`SELECT indexdef AS x FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`),
    funcoes: await q(`SELECT p.oid::regprocedure::text || ':' || md5(replace(prosrc, chr(13), '')) AS x FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace ORDER BY 1`),
  };
}
async function recusaScript(sql: string, re: RegExp, rotulo: string) {
  await assert.rejects(a.query(sql), (e) => re.test((e as Error).message), rotulo);
  await a.query("ROLLBACK");
}
async function recusaEmTx(preparo: string, sql: string, re: RegExp, rotulo: string) {
  await a.query("BEGIN");
  try {
    await a.query(preparo);
    await assert.rejects(a.query(semTransacao(sql)), (e) => re.test((e as Error).message), rotulo);
  } finally { await a.query("ROLLBACK"); }
}

test("125: ciclo — precheck e up repetido recusam; down → precheck passa → up reproduz o mesmo catálogo → postcheck passa", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com125) return t.skip("modelo sem a 125");
  const original = await catalogo();
  assert.ok(original.tabelas.includes("festa_pendencias_familia:r"));
  // A 125 não toca nas tabelas da Festa: nenhuma constraint, gatilho ou índice novo em festa_pendencias.
  assert.equal(original.gatilhos.some((g) => g.startsWith("festa_pendencias.") && g.includes("125")), false);
  assert.equal(original.constraints.some((c) => c.startsWith("festa_pendencias.") && c.includes("125")), false);

  await a.query(POS);
  await recusaScript(PRE, /125 precheck: 125 já/, "precheck com a 125 instalada");
  await recusaScript(UP, /125: já \(parcialmente\) presente/, "up repetido");
  assert.deepEqual(await catalogo(), original, "o up recusado não altera nada");

  await a.query(DOWN);
  const sem = await catalogo();
  assert.equal(sem.tabelas.some((x) => /area_familia_avisos_pagamento|festa_pendencias_familia|area_familia_aviso_empresa/.test(x)), false);
  assert.equal(sem.funcoes.some((f) => f.startsWith("kidmais_125_")), false, "nenhuma função da 125 sobra");
  assert.equal(sem.gatilhos.some((g) => g.includes("_125_")), false, "nenhum gatilho da 125 sobra");
  assert.equal(sem.constraints.some((c) => c.includes("AVISO_FIXO")), false, "o CHECK dos tipos volta ao da 123");
  await a.query(PRE);
  await recusaScript(DOWN, /area_familia_avisos_pagamento|125/, "down sem a 125 instalada");
  assert.deepEqual(await catalogo(), sem, "o down recusado não altera nada");

  await a.query(UP);
  await a.query(POS);
  assert.deepEqual(await catalogo(), original, "up/down/up: o catálogo volta idêntico");
});

test("125: precheck e up recusam sem a 123 e com CHECK de tipos fora do formato; tudo em ROLLBACK", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com125) return t.skip("modelo sem a 125");
  const down = semTransacao(DOWN);
  await recusaEmTx(`${down}; ALTER TABLE public.festa_pessoas RENAME TO festa_pessoas_x;`, PRE, /125 precheck: exige a 123/, "sem a 123");
  await recusaEmTx(`${down}; ALTER TABLE public.area_familia_eventos DROP CONSTRAINT area_familia_eventos_tipo_check;
    ALTER TABLE public.area_familia_eventos ADD CONSTRAINT area_familia_eventos_tipo_check CHECK (tipo IN ('ENTRADA'));`,
    PRE, /125 precheck: CHECK de area_familia_eventos.tipo fora do formato da 123/, "CHECK de tipos adulterado");
  await recusaEmTx(`${down}; ALTER TABLE public.festa_pessoas RENAME TO festa_pessoas_x;`, UP, /125: exige a 123/, "up sem a 123");
  await recusaEmTx(`${down}; CREATE FUNCTION public.kidmais_125_resto() RETURNS int LANGUAGE sql AS 'SELECT 1';`, PRE,
    /125 precheck: 125 já \(parcialmente\) presente/, "instalação parcial (função)");
  await a.query(POS);
});
