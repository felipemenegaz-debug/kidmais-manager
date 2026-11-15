import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";

/**
 * 124 (assinatura do cliente em papel) — ciclo da migration no PostgreSQL DESCARTÁVEL recriado do modelo 124 (sem linhas
 * de papel): precheck recusa a 124 instalada; up repetido recusa sem alterar nada; down COMMITA, devolve os corpos da 061
 * e o precheck volta a passar; up de novo reproduz o MESMO catálogo (tabelas, colunas, constraints, gatilhos, índices e
 * corpos de função) e o postcheck passa. O precheck recusa deriva da 061, instalação parcial e ausência da 122/123; o down
 * recusa deriva da 124. Cada recusa roda em transação e termina em ROLLBACK. A recusa do down COM linha de papel fica em
 * assinatura-papel-cliente.postgres.test.ts (precisa do contrato nativo real).
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
const UP = readFileSync("database/migrations/20261115_124_assinatura_papel_cliente.sql", "utf8");
const DOWN = readFileSync("database/rollback/20261115_124_assinatura_papel_cliente_down.sql", "utf8");
const PRE = readFileSync("database/checks/20261115_124_precheck.sql", "utf8");
const POS = readFileSync("database/checks/20261115_124_postcheck.sql", "utf8");
/** Corpo sem BEGIN;/COMMIT; de topo, para rodar dentro de uma transação do teste (as linhas internas "BEGIN" dos DO ficam). */
const semTransacao = (sql: string) => sql.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "");

let a: Client;
let com124 = false;
test.before(async () => {
  if (!opt()) return;
  a = await conectarDescartavel();
  com124 = (await a.query("SELECT to_regclass('public.contrato_assinaturas_papel') IS NOT NULL AS ok")).rows[0].ok;
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

/** Impressão digital do schema public: o que a 124 cria ou altera, e o resto, para provar que up/down/up não deixa resto. */
async function catalogo() {
  const q = async (sql: string) => (await a.query<{ x: string }>(sql)).rows.map((r) => r.x);
  return {
    tabelas: await q(`SELECT c.relname || ':' || c.relkind::text AS x FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','S','p') ORDER BY 1`),
    colunas: await q(`SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') AS x FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`),
    constraints: await q(`SELECT conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid) || ':' || convalidated || ':' || condeferrable || ':' || condeferred AS x FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1`),
    gatilhos: await q(`SELECT tgrelid::regclass::text || '.' || tgname || ':' || tgenabled::text || ':' || pg_get_triggerdef(oid) AS x FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`),
    indices: await q(`SELECT indexdef AS x FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`),
    funcoes: await q(`SELECT p.oid::regprocedure::text || ':' || md5(replace(prosrc, chr(13), '')) || ':' || p.prosecdef || ':' || coalesce(array_to_string(p.proconfig, ','), '') AS x FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace ORDER BY 1`),
    privilegios: await q(`SELECT c.relname || ':' || coalesce(array_to_string(c.relacl, ','), '') AS x FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'contrato_assinaturas%' ORDER BY 1`),
  };
}
/** Executa `sql` (script inteiro) e exige a recusa; a conexão volta limpa (ROLLBACK do que tiver ficado aberto). */
async function recusaScript(sql: string, re: RegExp, rotulo: string) {
  await assert.rejects(a.query(sql), (e) => re.test((e as Error).message), rotulo);
  await a.query("ROLLBACK");
}
/** Recusa dentro de uma transação do teste: `preparo` adultera, o script roda sem BEGIN/COMMIT e tudo volta no ROLLBACK. */
async function recusaEmTx(preparo: string, sql: string, re: RegExp, rotulo: string) {
  await a.query("BEGIN");
  try {
    await a.query(preparo);
    await assert.rejects(a.query(semTransacao(sql)), (e) => re.test((e as Error).message), rotulo);
  } finally { await a.query("ROLLBACK"); }
}
const instalada = async () => (await a.query("SELECT to_regclass('public.contrato_assinaturas_papel') IS NOT NULL AS ok")).rows[0].ok as boolean;

test("124: ciclo — precheck e up repetido recusam com a 124; down → precheck passa → up reproduz o mesmo catálogo → postcheck passa", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  assert.equal((await a.query("SELECT count(*)::int AS n FROM contrato_assinaturas_papel")).rows[0].n, 0, "o modelo vem sem linhas de papel");
  const original = await catalogo();
  assert.ok(original.tabelas.includes("contrato_assinaturas_papel:r"));

  await a.query(POS);
  await recusaScript(PRE, /124 precheck: 124 já aplicada/, "precheck com a 124 instalada");
  await recusaScript(UP, /124 já aplicada/, "up repetido");
  assert.deepEqual(await catalogo(), original, "o up recusado não altera nada");

  await a.query(DOWN);
  assert.equal(await instalada(), false, "down removeu a tabela");
  const semPapel = await catalogo();
  assert.equal(semPapel.funcoes.some((f) => f.startsWith("kidmais124_")), false, "nenhuma função kidmais124_ sobra");
  assert.equal(semPapel.gatilhos.some((g) => g.includes("contrato_assinaturas_papel")), false, "nenhum gatilho da 124 sobra");
  assert.equal(semPapel.constraints.some((c) => c.includes("PAPEL_CLIENTE")), false, "o CHECK do método volta ao da 061");
  await a.query(PRE);
  await recusaScript(DOWN, /contrato_assinaturas_papel|124/, "down sem a 124 instalada");
  assert.deepEqual(await catalogo(), semPapel, "o down recusado não altera nada");

  await a.query(UP);
  await a.query(POS);
  assert.deepEqual(await catalogo(), original, "up/down/up: o catálogo volta idêntico");
  await recusaScript(PRE, /124 precheck: 124 já aplicada/, "precheck depois do up");
});

test("124: precheck (sem a 124) recusa deriva da 061, instalação parcial e ausência da 122/123; tudo em ROLLBACK", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  // O precheck só faz sentido sem a 124: o down roda dentro da mesma transação de cada caso e volta no ROLLBACK.
  const down = semTransacao(DOWN);
  await recusaEmTx(`${down};
    CREATE OR REPLACE FUNCTION public.kidmais_validar_fluxo_contrato() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NULL; END $f$;`,
    PRE, /124 precheck: validação de contrato diverge da 061/, "deriva da validação de contrato");
  await recusaEmTx(`${down};
    CREATE OR REPLACE FUNCTION public.kidmais124_resto() RETURNS int LANGUAGE sql AS 'SELECT 1';`, PRE, /124 precheck: 124 já aplicada ou parcialmente presente/, "instalação parcial (função)");
  await recusaEmTx(`${down}; ALTER TABLE public.oportunidades_acoes RENAME TO oportunidades_acoes_x;`, PRE, /124 precheck: exige a 122/, "sem a 122");
  await recusaEmTx(`${down}; ALTER TABLE public.festa_pessoas RENAME TO festa_pessoas_x;`, PRE, /124 precheck: exige a 123/, "sem a 123");
  // O up tem o mesmo bloco inicial: deriva da 061 também recusa a aplicação.
  await recusaEmTx(`${down};
    CREATE OR REPLACE FUNCTION public.kidmais_validar_fluxo_contrato() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NULL; END $f$;`,
    UP, /124: validação de contrato diverge da 061/, "up com deriva da 061");
  assert.equal(await instalada(), true, "fora das transações a 124 segue instalada");
  await a.query(POS);
});

test("124: down recusa deriva da 124 (corpo trocado) e dependência posterior; nada muda", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com124) return t.skip("modelo sem a 124");
  const antes = await catalogo();
  await recusaEmTx(`CREATE OR REPLACE FUNCTION public.kidmais124_imutavel() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NULL; END $f$;`,
    DOWN, /124 .*função .* ausente ou divergente da 124/, "corpo da 124 adulterado");
  await recusaEmTx(`CREATE FUNCTION public.kidmais125_depende() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM public.contrato_assinaturas_papel';`,
    DOWN, /124: rollback recusado; outra função depende/, "função posterior que lê a tabela da 124");
  assert.deepEqual(await catalogo(), antes);
  await a.query(POS);
});
