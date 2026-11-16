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

// Controles negativos do postcheck (achado P2 do Astra em c71bae8a + P3 da pré-revisão): com as três tabelas presentes o
// aplicador genérico só roda o postcheck, então cada 125 incompleta ou alterada abaixo tem de ser recusada, com a
// mensagem do item que falta. Cada caso roda numa transação desfeita (ROLLBACK).
const DO_POS = POS.slice(POS.indexOf("DO $$"), POS.indexOf("END $$;") + "END $$;".length);
const A = "area_familia_avisos_pagamento", P = "festa_pendencias_familia", E = "area_familia_aviso_empresa";
const TIPOS_123_MAIS_125_SEM_AVISO_FIXO = "'LINK_GERADO','LINK_REVOGADO','ENTRADA','SAIR','SAIR_DE_TODOS','BUFFET_DESCONECTOU','PESSOA_CADASTRADA','PESSOA_REMOVIDA','CONTATO_ALTERADO','SESSOES_DERRUBADAS','AVISO_PAGAMENTO','AVISO_PAGAMENTO_TRATADO','PENDENCIA_FEITA','PENDENCIA_DEVOLVIDA','PENDENCIA_VISIBILIDADE'";
const NEGATIVOS: Array<[string, string, RegExp]> = [
  ["FK parcela ausente", `ALTER TABLE ${A} DROP CONSTRAINT ${A}_parcela_id_fkey`, /constraints de public.area_familia_avisos_pagamento/],
  ["FK parcela com ON DELETE CASCADE", `ALTER TABLE ${A} DROP CONSTRAINT ${A}_parcela_id_fkey; ALTER TABLE ${A} ADD CONSTRAINT ${A}_parcela_id_fkey FOREIGN KEY (parcela_id) REFERENCES pagamento_parcelas(id) ON DELETE CASCADE`, /constraints de public.area_familia_avisos_pagamento/],
  ["FK parcela NOT VALID", `ALTER TABLE ${A} DROP CONSTRAINT ${A}_parcela_id_fkey; ALTER TABLE ${A} ADD CONSTRAINT ${A}_parcela_id_fkey FOREIGN KEY (parcela_id) REFERENCES pagamento_parcelas(id) ON DELETE RESTRICT NOT VALID`, /constraints de public.area_familia_avisos_pagamento/],
  ["FK tratado_por ausente", `ALTER TABLE ${A} DROP CONSTRAINT ${A}_tratado_por_usuario_id_fkey`, /constraints de public.area_familia_avisos_pagamento/],
  ["CHECK observacao ausente", `ALTER TABLE ${A} DROP CONSTRAINT ${A}_observacao_check`, /constraints de public.area_familia_avisos_pagamento/],
  ["CHECK estado com outra expressão", `ALTER TABLE ${A} DROP CONSTRAINT ${A}_estado_check; ALTER TABLE ${A} ADD CONSTRAINT ${A}_estado_check CHECK (estado IN ('PENDENTE','CONFERIDO','DESCARTADO','OUTRO'))`, /constraints de public.area_familia_avisos_pagamento/],
  ["constraint a mais", `ALTER TABLE ${A} ADD CONSTRAINT ${A}_x_check CHECK (true)`, /constraints de public.area_familia_avisos_pagamento/],
  ["índice ausente", `DROP INDEX ${A}_festa_idx`, /índices de public.area_familia_avisos_pagamento/],
  ["índice parcial sem WHERE", `DROP INDEX ${A}_pendente_uk; CREATE UNIQUE INDEX ${A}_pendente_uk ON ${A} (parcela_id, estado)`, /índices de public.area_familia_avisos_pagamento/],
  ["default removido", `ALTER TABLE ${A} ALTER COLUMN estado DROP DEFAULT`, /colunas de public.area_familia_avisos_pagamento/],
  ["coluna opcional virou NOT NULL", `ALTER TABLE ${A} ALTER COLUMN observacao SET NOT NULL`, /colunas de public.area_familia_avisos_pagamento/],
  ["gatilho com outra função", `DROP TRIGGER ${A}_validar_trg ON ${A}; CREATE TRIGGER ${A}_validar_trg BEFORE INSERT OR UPDATE OR DELETE ON ${A} FOR EACH ROW EXECUTE FUNCTION kidmais_set_atualizado_em()`, /gatilhos de public.area_familia_avisos_pagamento/],
  ["gatilho com menos eventos", `DROP TRIGGER ${A}_validar_trg ON ${A}; CREATE TRIGGER ${A}_validar_trg BEFORE INSERT ON ${A} FOR EACH ROW EXECUTE FUNCTION kidmais_125_aviso_pagamento_validar()`, /gatilhos de public.area_familia_avisos_pagamento/],
  ["gatilho desligado", `ALTER TABLE ${A} DISABLE TRIGGER ${A}_validar_trg`, /gatilhos de public.area_familia_avisos_pagamento/],
  ["FK empresa de pendências ausente", `ALTER TABLE ${P} DROP CONSTRAINT ${P}_empresa_id_fkey`, /constraints de public.festa_pendencias_familia/],
  ["FK devolvido_por ausente", `ALTER TABLE ${P} DROP CONSTRAINT ${P}_devolvido_por_usuario_id_fkey`, /constraints de public.festa_pendencias_familia/],
  ["CHECK feito ausente", `ALTER TABLE ${P} DROP CONSTRAINT ${P}_feito_check`, /constraints de public.festa_pendencias_familia/],
  ["gatilho atualizado_em ausente", `DROP TRIGGER ${P}_atualizado_em_trg ON ${P}`, /gatilhos de public.festa_pendencias_familia/],
  ["FK empresa do aviso fixo ausente", `ALTER TABLE ${E} DROP CONSTRAINT ${E}_empresa_id_fkey`, /constraints de public.area_familia_aviso_empresa/],
  ["CHECK texto do aviso fixo ausente", `ALTER TABLE ${E} DROP CONSTRAINT ${E}_texto_check`, /constraints de public.area_familia_aviso_empresa/],
  ["atualizado_em em função homônima de outro schema", `CREATE SCHEMA x125; CREATE FUNCTION x125.kidmais_set_atualizado_em() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
     DROP TRIGGER ${E}_atualizado_em_trg ON ${E}; CREATE TRIGGER ${E}_atualizado_em_trg BEFORE UPDATE ON ${E} FOR EACH ROW EXECUTE FUNCTION x125.kidmais_set_atualizado_em()`,
    /gatilhos de public.area_familia_aviso_empresa|atualizado_em fora/],
  ["tabela UNLOGGED", `ALTER TABLE ${E} SET UNLOGGED`, /area_familia_aviso_empresa não é tabela comum persistente/],
  ["tabela com RLS", `ALTER TABLE ${P} ENABLE ROW LEVEL SECURITY`, /festa_pendencias_familia não é tabela comum persistente/],
  ["NOT NULL não validado", `ALTER TABLE ${E} ALTER COLUMN texto DROP NOT NULL; ALTER TABLE ${E} ADD CONSTRAINT ${E}_texto_not_null NOT NULL texto NOT VALID`,
    /area_familia_aviso_empresa não é tabela comum persistente/],
  ["CHECK de tipos sem AVISO_FIXO", `ALTER TABLE area_familia_eventos DROP CONSTRAINT area_familia_eventos_tipo_check; ALTER TABLE area_familia_eventos ADD CONSTRAINT area_familia_eventos_tipo_check CHECK (tipo IN (${TIPOS_123_MAIS_125_SEM_AVISO_FIXO}))`, /CHECK de area_familia_eventos.tipo/],
  ["gatilho da 125 em tabela da 123 ausente", "DROP TRIGGER area_familia_eventos_125_pessoas_trg ON area_familia_eventos", /gatilho area_familia_eventos_125_pessoas_trg/],
  ["gatilho de remoção sem UPDATE OF", "DROP TRIGGER festa_pessoas_125_remocao_trg ON festa_pessoas; CREATE TRIGGER festa_pessoas_125_remocao_trg BEFORE UPDATE ON festa_pessoas FOR EACH ROW EXECUTE FUNCTION kidmais_125_remocao_por_pessoa()", /gatilho festa_pessoas_125_remocao_trg/],
  ["gatilho da 125 em tabela da 123 desligado", "ALTER TABLE festa_links_area DISABLE TRIGGER festa_links_area_125_autoria_trg", /gatilho festa_links_area_125_autoria_trg/],
  ["corpo de função trocado", "CREATE OR REPLACE FUNCTION kidmais_125_pessoa_ativa(p_pessoa uuid, p_festa uuid) RETURNS boolean LANGUAGE sql STABLE AS 'SELECT true'", /função public.kidmais_125_pessoa_ativa/],
  ["função com SECURITY DEFINER e o mesmo corpo", "ALTER FUNCTION kidmais_125_pessoa_ativa(uuid, uuid) SECURITY DEFINER", /função public.kidmais_125_pessoa_ativa/],
  ["função VOLATILE e o mesmo corpo", "ALTER FUNCTION kidmais_125_contratante_ativo(uuid, uuid) VOLATILE", /função public.kidmais_125_contratante_ativo/],
  ["função com SET search_path e o mesmo corpo", "ALTER FUNCTION kidmais_125_link_por_pessoa() SET search_path = public", /função public.kidmais_125_link_por_pessoa/],
  ["função ausente", "DROP FUNCTION kidmais_125_contratante_ativo(uuid, uuid)", /função public.kidmais_125_contratante_ativo/],
];

test("125: o postcheck recusa a 125 incompleta ou alterada (um caso por transação, ROLLBACK)", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com125) return t.skip("modelo sem a 125");
  for (const [rotulo, mutacao, re] of NEGATIVOS) {
    await a.query("BEGIN");
    try {
      await a.query("SET LOCAL search_path = public, pg_catalog");
      await a.query(mutacao);
      await assert.rejects(a.query(DO_POS), (e) => re.test((e as Error).message), rotulo);
    } finally { await a.query("ROLLBACK"); }
  }
  await a.query(POS);
});
