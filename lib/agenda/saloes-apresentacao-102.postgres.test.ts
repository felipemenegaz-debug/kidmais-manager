import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { cenario, id, type Cenario } from "../../scripts/integracao-importados-test-support.ts";

/**
 * 102 (apresentação do salão) no PostgreSQL DESCARTÁVEL. Plano rev. 4 aprovado com ressalvas pelo Astra (25/10/2026):
 *   * modelo 102 (inventário sem a 098, com 099/100/102): SQL direto em todos os CHECKs, declaração versionada, catálogo
 *     imutável, identidade dos itens, limites de 4 destaques e 8 fotos sob duas conexões reais (espera observada),
 *     lista do que pode mudar nas fotos, TRUNCATE/DELETE recusados, isolamento por empresa e capacidade da agenda;
 *   * modelo 097 (staging de hoje, sem 098/100/102): precheck → migration → postcheck, reaplicação recusada, rollback
 *     neutro aceito com salões preexistentes e recusado com qualquer conteúdo novo (inclusive foto removida);
 *   * modelo 098: a 102 recusa antes de alterar qualquer coisa.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arquivo = (p: string) => readFileSync(resolve(root, p), "utf8");
const MIGRATION = "database/migrations/20261025_102_saloes_apresentacao.sql";
const ROLLBACK = "database/rollback/20261025_102_saloes_apresentacao_down.sql";
const PRECHECK = "database/checks/20261025_102_precheck.sql";
const POSTCHECK = "database/checks/20261025_102_postcheck.sql";
const PRECHECK_098 = "database/checks/20261023_098_precheck.sql";

let a: Client;
let modelo: "098" | "097" | "102" = "097";

async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => trecho.test(e instanceof Error ? e.message : String(e)));
  await a.query("ROLLBACK").catch(() => undefined);
}

/** Erro por SQLSTATE e constraint (a tradução amigável da rota usa esses dois). */
async function recusaPor(promessa: Promise<unknown>, codigo: string, constraint?: string) {
  await assert.rejects(promessa, (e: unknown) => {
    const pg = e as { code?: string; constraint?: string };
    return pg.code === codigo && (constraint === undefined || pg.constraint === constraint);
  });
  await a.query("ROLLBACK").catch(() => undefined);
}

async function salao(c: Cenario, capacidade: number | null = 100, nome = `Salão ${randomBytes(3).toString("hex")}`) {
  return id(a, `INSERT INTO agenda_saloes (empresa_id, estabelecimento_id, nome, capacidade_convidados) VALUES ($1::uuid, NULL, $2, $3) RETURNING id`,
    [c.empresa, nome, capacidade]);
}

type Estado = { conteudo_versao: number; declaracao_versao: number | null; declaracao_em: Date | null };
const estado = async (s: string) => (await a.query<Estado>(
  `SELECT conteudo_versao, declaracao_versao, declaracao_em FROM agenda_saloes WHERE id = $1::uuid`, [s])).rows[0];

async function declarar(s: string, usuario: string, versao?: number) {
  const v = versao ?? (await estado(s)).conteudo_versao;
  await a.query(`UPDATE agenda_saloes SET declaracao_em = clock_timestamp(), declaracao_por = $2::uuid, declaracao_versao = $3 WHERE id = $1::uuid`, [s, usuario, v]);
}

function webp(n = 64) {
  const conteudo = randomBytes(n);
  return { conteudo, sha: createHash("sha256").update(conteudo).digest("hex") };
}

async function foto(c: Cenario, s: string, ordem: number, db: Client = a, legenda = `Foto ${ordem}`) {
  const { conteudo, sha } = webp();
  return (await db.query<{ id: string }>(
    `INSERT INTO agenda_salao_fotos (empresa_id, salao_id, conteudo, mime, bytes, largura, altura, sha256, legenda, ordem, origem, criado_por)
     VALUES ($1::uuid, $2::uuid, $3, 'image/webp', $4, 800, 600, $5, $6, $7, 'UPLOAD', $8::uuid) RETURNING id`,
    [c.empresa, s, conteudo, conteudo.length, sha, legenda, ordem, c.usuario])).rows[0].id;
}

async function item(c: Cenario, s: string, campos: { grupo: string; codigo?: string; proprio?: string; destaque?: boolean; detalhe?: string }, db: Client = a) {
  return (await db.query<{ id: string }>(
    `INSERT INTO agenda_salao_itens (empresa_id, salao_id, grupo, item_codigo, item_proprio, destaque, detalhe)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7) RETURNING id`,
    [c.empresa, s, campos.grupo, campos.codigo ?? null, campos.proprio ?? null, campos.destaque ?? false, campos.detalhe ?? null])).rows[0].id;
}

/** Espera até `bloqueada` estar bloqueada pela sessão `segura` (pg_blocking_pids), sem sleep fixo como prova. */
async function esperarBloqueio(pidSegura: number, pidBloqueada: number) {
  for (let i = 0; i < 200; i++) {
    const r = await a.query<{ ok: boolean }>(`SELECT $1::int = ANY (pg_blocking_pids($2::int)) AS ok`, [pidSegura, pidBloqueada]);
    if (r.rows[0]?.ok) return;
    await new Promise((fim) => setTimeout(fim, 25));
  }
  assert.fail("a segunda conexão não ficou esperando a primeira");
}

test.before(async () => {
  a = await conectarDescartavel();
  const r = (await a.query<{ m098: boolean; m102: boolean }>(
    `SELECT to_regprocedure('public.kidmais098_hoje()') IS NOT NULL AS m098, to_regclass('public.agenda_salao_fotos') IS NOT NULL AS m102`)).rows[0];
  modelo = r.m098 ? "098" : r.m102 ? "102" : "097";
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

// ---------------------------------------------------------------------------------------------------------------------
// Modelo 098: recusa sem alterar nada.
// ---------------------------------------------------------------------------------------------------------------------
test("modelo 098: precheck e migration da 102 recusam (098 instalada) e nada muda", async (t) => {
  if (modelo !== "098") { t.skip("só no modelo 098"); return; }
  await recusa(a.query(arquivo(PRECHECK)), /102 precheck: 098 instalada/);
  await recusa(a.query(arquivo(MIGRATION)), /102: precheck falhou \(098 instalada/);
  assert.equal((await a.query<{ ok: boolean }>(`SELECT to_regclass('public.agenda_salao_fotos') IS NULL AS ok`)).rows[0].ok, true);
  assert.equal((await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'agenda_saloes' AND column_name = 'conteudo_versao'`)).rows[0].n, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// Modelo 097: aplicação, reaplicação recusada e rollback neutro / com conteúdo.
// ---------------------------------------------------------------------------------------------------------------------
test("modelo 097: aplica uma vez sobre salões preexistentes (neutros), recusa reaplicar; rollback neutro aceito", async (t) => {
  if (modelo !== "097") { t.skip("só no modelo 097"); return; }
  const c = await cenario(a, 0);
  const s = await salao(c, 80);
  await recusa(a.query(arquivo(POSTCHECK)), /102 postcheck: colunas ou tabelas ausentes/);
  await a.query(arquivo(PRECHECK));
  await a.query(arquivo(MIGRATION));
  await a.query(arquivo(POSTCHECK));
  const neutro = (await a.query(`SELECT exclusivos, conteudo_versao, declaracao_em, frase FROM agenda_saloes WHERE id = $1::uuid`, [s])).rows[0];
  assert.deepEqual(neutro, { exclusivos: [], conteudo_versao: 0, declaracao_em: null, frase: null });
  await recusa(a.query(arquivo(PRECHECK)), /102 precheck: 102 já aplicada ou parcial/);
  await recusa(a.query(arquivo(MIGRATION)), /102: precheck falhou \(102 já aplicada ou parcial/);
  // Rollback neutro (salão preexistente com os defaults novos) é aceito e devolve o schema anterior.
  await a.query(arquivo(ROLLBACK));
  await a.query(arquivo(PRECHECK));
  // Reaplica para provar os bloqueios do rollback com conteúdo.
  await a.query(arquivo(MIGRATION));
  await a.query(arquivo(POSTCHECK));
});

/** Corpo do down sem BEGIN/COMMIT próprios: cada guarda é provada numa transação do teste, desfeita no fim. */
const corpoDoDown = () => arquivo(ROLLBACK).replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "");

test("modelo 097: rollback recusado por cada guarda isolada — foto removida, item, campo, versão e declaração", async (t) => {
  if (modelo !== "097") { t.skip("só no modelo 097"); return; }
  const casos: [string, (c: Cenario, s: string) => Promise<unknown>, RegExp][] = [
    ["foto removida", async (c, s) => {
      const f = await foto(c, s, 1);
      await a.query(`UPDATE agenda_salao_fotos SET removida_em = clock_timestamp() WHERE id = $1::uuid`, [f]);
    }, /102 rollback: há fotos de salão \(inclusive removidas\)/],
    ["item", (c, s) => item(c, s, { grupo: "CONFORTO", codigo: "WIFI" }), /102 rollback: há itens de salão/],
    // INSERT com campo preenchido mantém a versão 0: prova a guarda de campo sem a de versão.
    ["campo preenchido (versão 0)", (c) => a.query(`INSERT INTO agenda_saloes (empresa_id, nome, capacidade_convidados, frase) VALUES ($1::uuid, 'Com frase', 50, 'Aconchegante')`, [c.empresa]),
      /102 rollback: há salão com apresentação preenchida/],
    ["exclusivos", (c) => a.query(`INSERT INTO agenda_saloes (empresa_id, nome, exclusivos) VALUES ($1::uuid, 'Com exclusivos', ARRAY['ENTRADA'])`, [c.empresa]),
      /102 rollback: há salão com apresentação preenchida/],
    ["só versão > 0 (campos voltaram a NULL)", async (_c, s) => {
      await a.query(`UPDATE agenda_saloes SET frase = 'Temporária' WHERE id = $1::uuid`, [s]);
      await a.query(`UPDATE agenda_saloes SET frase = NULL WHERE id = $1::uuid`, [s]);
    }, /102 rollback: há salão com apresentação preenchida, versão ou declaração/],
  ];
  for (const [nome, preparar, motivo] of casos) {
    await a.query("BEGIN");
    try {
      const c = await cenario(a, 0);
      const s = await salao(c, 60);
      await preparar(c, s);
      await assert.rejects(a.query(corpoDoDown()), (e: unknown) => motivo.test(e instanceof Error ? e.message : String(e)), nome);
    } finally {
      await a.query("ROLLBACK");
    }
  }
  // Nenhuma das tentativas alterou o schema.
  assert.equal((await a.query<{ ok: boolean }>(`SELECT to_regclass('public.agenda_salao_fotos') IS NOT NULL AS ok`)).rows[0].ok, true);
  await a.query(arquivo(POSTCHECK));
});

// ---------------------------------------------------------------------------------------------------------------------
// Modelo 102: comportamento.
// ---------------------------------------------------------------------------------------------------------------------
const so102 = (t: { skip: (m: string) => void }) => { if (modelo !== "102") { t.skip("só no modelo 102"); return false; } return true; };

test("102: integridade repetível; gatilho desligado ou corpo alterado são detectados pelo postcheck e pela integridade", async (t) => {
  if (!so102(t)) return;
  const INTEGRIDADE = "database/checks/20261025_102_integridade.sql";
  const integra = async () => (await a.query<{ integra_102: boolean }>(arquivo(INTEGRIDADE))).rows[0].integra_102;
  assert.equal(await integra(), true);
  await a.query(arquivo(POSTCHECK));
  await a.query("BEGIN");
  await a.query("ALTER TABLE agenda_salao_fotos DISABLE TRIGGER agenda_salao_fotos_102_antes_trg");
  assert.equal(await integra(), false);
  await assert.rejects(a.query(arquivo(POSTCHECK)), /102 postcheck: funções, constraints, gatilhos ou índices/);
  await a.query("ROLLBACK");
  await a.query("BEGIN");
  await a.query(`CREATE OR REPLACE FUNCTION public.kidmais102_sem_truncate() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$ BEGIN RETURN NULL; END $$`);
  assert.equal(await integra(), false);
  await a.query("ROLLBACK");
  assert.equal(await integra(), true);
});

test("102 (parecer do Astra 26/10, P2-3): deriva SEMÂNTICA com nome e contagem preservados é detectada pelo postcheck, pela integridade e recusa o rollback", async (t) => {
  if (!so102(t)) return;
  const INTEGRIDADE = "database/checks/20261025_102_integridade.sql";
  const integra = async () => (await a.query<{ integra_102: boolean }>(arquivo(INTEGRIDADE))).rows[0].integra_102;
  const derivas: Array<[string, string]> = [
    ["CHECK(true) no lugar de sentados", `ALTER TABLE agenda_saloes DROP CONSTRAINT agenda_saloes_102_sentados_ck;
      ALTER TABLE agenda_saloes ADD CONSTRAINT agenda_saloes_102_sentados_ck CHECK (true)`],
    ["índice de ordem recriado sem unicidade", `DROP INDEX agenda_salao_fotos_ordem_uk;
      CREATE INDEX agenda_salao_fotos_ordem_uk ON public.agenda_salao_fotos (empresa_id, salao_id, ordem) WHERE removida_em IS NULL`],
    ["índice de ordem com predicado alterado", `DROP INDEX agenda_salao_fotos_ordem_uk;
      CREATE UNIQUE INDEX agenda_salao_fotos_ordem_uk ON public.agenda_salao_fotos (empresa_id, salao_id, ordem)`],
    ["gatilho com WHEN(false)", `DROP TRIGGER agenda_salao_fotos_102_depois_trg ON public.agenda_salao_fotos;
      CREATE TRIGGER agenda_salao_fotos_102_depois_trg AFTER INSERT OR UPDATE ON public.agenda_salao_fotos FOR EACH ROW WHEN (false) EXECUTE FUNCTION public.kidmais102_foto_depois()`],
    ["configuração de função alterada (search_path)", `ALTER FUNCTION public.kidmais102_sem_truncate() SET search_path = public`],
    ["função passada a SECURITY DEFINER", `ALTER FUNCTION public.kidmais102_invalidar_salao(uuid) SECURITY DEFINER`],
    ["catálogo com nome adulterado (gatilho de imutabilidade desligado)", `ALTER TABLE agenda_salao_itens_catalogo DISABLE TRIGGER agenda_salao_itens_catalogo_102_imutavel_trg;
      UPDATE agenda_salao_itens_catalogo SET nome = nome || ' x' WHERE codigo = (SELECT min(codigo) FROM agenda_salao_itens_catalogo);
      ALTER TABLE agenda_salao_itens_catalogo ENABLE TRIGGER agenda_salao_itens_catalogo_102_imutavel_trg`],
  ];
  assert.equal(await integra(), true, "controle: schema íntegro");
  for (const [nome, sql] of derivas) {
    await a.query("BEGIN");
    try {
      await a.query(sql);
      assert.equal(await integra(), false, `integridade: ${nome}`);
      await a.query("SAVEPOINT p");
      await assert.rejects(a.query(arquivo(POSTCHECK)), /102 postcheck: retrato semântico divergente/, `postcheck: ${nome}`);
      await a.query("ROLLBACK TO SAVEPOINT p");
      // Rollback (sem o BEGIN/COMMIT próprios): recusa antes de remover qualquer objeto.
      await assert.rejects(a.query(corpoDoDown()), /102 rollback: schema da 102 divergente do esperado/, `rollback: ${nome}`);
    } finally {
      await a.query("ROLLBACK");
    }
  }
  assert.equal(await integra(), true, "controle final: nada ficou alterado");
});

test("102: precheck da 098 recusa sobre a 102 (retrato 094 alterado) — 098 não passa por cima", async (t) => {
  if (!so102(t)) return;
  await assert.rejects(a.query(arquivo(PRECHECK_098)));
  await a.query("ROLLBACK").catch(() => undefined);
});

test("102: CHECKs de capacidade, área, idade, frase, exclusivos e mês das fotos (SQL direto, sem UNKNOWN)", async (t) => {
  if (!so102(t)) return;
  const c = await cenario(a, 0);
  const s = await salao(c, 100);
  const semCapacidade = await salao(c, null);
  const upd = (sid: string, set: string) => a.query(`UPDATE agenda_saloes SET ${set} WHERE id = $1::uuid`, [sid]);
  await recusaPor(upd(semCapacidade, "convidados_sentados = 10"), "23514", "agenda_saloes_102_sentados_ck");
  await recusaPor(upd(semCapacidade, "convidados_minimo = 10"), "23514", "agenda_saloes_102_minimo_ck");
  await recusaPor(upd(s, "convidados_sentados = 101"), "23514", "agenda_saloes_102_sentados_ck");
  await recusaPor(upd(s, "convidados_minimo = 0"), "23514", "agenda_saloes_102_minimo_ck");
  await upd(s, "convidados_sentados = 90, convidados_minimo = 50");
  // A agenda reduzindo o máximo abaixo de sentados: recusa a transação; máximo NULL com dependentes também.
  await recusaPor(upd(s, "capacidade_convidados = 80"), "23514", "agenda_saloes_102_sentados_ck");
  await recusaPor(upd(s, "capacidade_convidados = NULL"), "23514");
  await recusaPor(upd(s, "area_m2 = 0"), "23514", "agenda_saloes_102_area_ck");
  await recusaPor(upd(s, "idade_min = 4"), "23514", "agenda_saloes_102_idade_ck");
  await recusaPor(upd(s, "idade_min = 8, idade_max = 4"), "23514", "agenda_saloes_102_idade_ck");
  await recusaPor(upd(s, "idade_min = 4, idade_max = 18"), "23514", "agenda_saloes_102_idade_ck");
  await upd(s, "idade_min = 4, idade_max = 12, area_m2 = 260");
  await recusaPor(upd(s, "frase = ' com espaço'"), "23514", "agenda_saloes_102_frase_ck");
  await recusaPor(upd(s, `frase = '${"x".repeat(81)}'`), "23514", "agenda_saloes_102_frase_ck");
  await recusaPor(upd(s, "frase = ''"), "23514", "agenda_saloes_102_frase_ck");
  await recusaPor(upd(s, "exclusivos = ARRAY['ENTRADA','ENTRADA']"), "23514", "agenda_saloes_102_exclusivos_ck");
  await recusaPor(upd(s, "exclusivos = ARRAY['PISCINA']"), "23514", "agenda_saloes_102_exclusivos_ck");
  await recusaPor(upd(s, "exclusivos = ARRAY['ENTRADA', NULL]"), "23514", "agenda_saloes_102_exclusivos_ck");
  await recusaPor(upd(s, "exclusivos = ARRAY[ARRAY['ENTRADA']]"), "23514", "agenda_saloes_102_exclusivos_ck");
  await recusaPor(upd(s, "exclusivos = NULL"), "23502");
  await upd(s, "exclusivos = ARRAY['ENTRADA','BRINQUEDOS']");
  await recusaPor(upd(s, "fotos_referencia = '2026-03-15'"), "23514", "agenda_saloes_102_fotos_referencia_ck");
  await recusaPor(upd(s, "fotos_referencia = date_trunc('month', clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date + interval '1 month'"),
    "23514", "agenda_saloes_102_fotos_referencia_ck");
  await upd(s, "fotos_referencia = date_trunc('month', clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date");
  await upd(s, "fotos_referencia = '2026-03-01'");
  // Salão novo nasce neutro: declaração ou versão no INSERT são recusadas.
  await recusaPor(a.query(`INSERT INTO agenda_saloes (empresa_id, nome, conteudo_versao) VALUES ($1::uuid, 'Novo', 3)`, [c.empresa]), "23514");
});

test("102: declaração exige a versão vigente; mudança pública (inclusive da agenda) anula; ordem e no-op não", async (t) => {
  if (!so102(t)) return;
  const c = await cenario(a, 0);
  const s = await salao(c, 100, "Salão Aventura");
  assert.equal((await estado(s)).conteudo_versao, 0);
  await a.query(`UPDATE agenda_saloes SET frase = 'Mais espaço para correr' WHERE id = $1::uuid`, [s]);
  assert.equal((await estado(s)).conteudo_versao, 1);
  await recusaPor(declarar(s, c.usuario, 0), "23514", "agenda_saloes_102_declaracao_ck");
  await declarar(s, c.usuario);
  assert.equal((await estado(s)).declaracao_versao, 1);
  // No-op e ordem não invalidam.
  await a.query(`UPDATE agenda_saloes SET frase = 'Mais espaço para correr', ordem = ordem + 1 WHERE id = $1::uuid`, [s]);
  assert.equal((await estado(s)).conteudo_versao, 1);
  assert.notEqual((await estado(s)).declaracao_em, null);
  // A agenda (nome, capacidade, ativo) invalida, mesmo que a mesma instrução tente regravar a declaração.
  await a.query(`UPDATE agenda_saloes SET nome = 'Salão Aventura II', declaracao_versao = 1 WHERE id = $1::uuid`, [s]);
  assert.deepEqual(await estado(s), { conteudo_versao: 2, declaracao_versao: null, declaracao_em: null });
  await declarar(s, c.usuario);
  await a.query(`UPDATE agenda_saloes SET capacidade_convidados = 120 WHERE id = $1::uuid`, [s]);
  assert.equal((await estado(s)).declaracao_em, null);
  await declarar(s, c.usuario);
  await a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [s]);
  assert.equal((await estado(s)).declaracao_em, null);
  // Versão não recua.
  await recusaPor(a.query(`UPDATE agenda_saloes SET conteudo_versao = 0 WHERE id = $1::uuid`, [s]), "23514", "agenda_saloes_102_versao_ck");
});

test("102: catálogo imutável — nome, idade, grupo e código recusados; DELETE e TRUNCATE recusados; só ativo muda", async (t) => {
  if (!so102(t)) return;
  await recusaPor(a.query(`UPDATE agenda_salao_itens_catalogo SET nome = 'Outro' WHERE codigo = 'BRINQUEDAO'`), "42501");
  await recusaPor(a.query(`UPDATE agenda_salao_itens_catalogo SET idade_min = 3 WHERE codigo = 'BRINQUEDAO'`), "42501");
  await recusaPor(a.query(`UPDATE agenda_salao_itens_catalogo SET grupo = 'ESPACO' WHERE codigo = 'FRALDARIO'`), "42501");
  await recusaPor(a.query(`UPDATE agenda_salao_itens_catalogo SET codigo = 'WIFI2' WHERE codigo = 'WIFI'`), "42501");
  await recusaPor(a.query(`UPDATE agenda_salao_itens_catalogo SET pede_detalhe = true WHERE codigo = 'WIFI'`), "42501");
  await recusaPor(a.query(`DELETE FROM agenda_salao_itens_catalogo WHERE codigo = 'WIFI'`), "42501");
  await recusaPor(a.query(`TRUNCATE agenda_salao_itens_catalogo CASCADE`), "42501");
  assert.equal((await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM agenda_salao_itens_catalogo`)).rows[0].n, 28);
  // ativo muda (só por migration na prática); item inativo sai das escolhas novas e o já escolhido continua com o texto.
  const c = await cenario(a, 0);
  const s = await salao(c);
  await item(c, s, { grupo: "CONFORTO", codigo: "WIFI" });
  await a.query("BEGIN");
  await a.query(`UPDATE agenda_salao_itens_catalogo SET ativo = false WHERE codigo = 'WIFI'`);
  const s2 = await salao(c);
  await assert.rejects(item(c, s2, { grupo: "CONFORTO", codigo: "WIFI" }), (e: { constraint?: string }) => e.constraint === "agenda_salao_itens_catalogo_fk");
  await a.query("ROLLBACK");
  assert.equal((await a.query<{ nome: string }>(`SELECT c.nome FROM agenda_salao_itens i JOIN agenda_salao_itens_catalogo c ON c.codigo = i.item_codigo
     WHERE i.salao_id = $1::uuid`, [s])).rows[0].nome, "Wi-Fi");
});

test("102: itens — grupo coerente com o catálogo, identidade imutável, próprio normalizado/único, 4 destaques, TRUNCATE recusado", async (t) => {
  if (!so102(t)) return;
  const c = await cenario(a, 0);
  const s = await salao(c);
  await recusaPor(item(c, s, { grupo: "ADULTOS", codigo: "BRINQUEDAO" }), "23503", "agenda_salao_itens_catalogo_fk");
  await recusaPor(item(c, s, { grupo: "BRINCADEIRAS" }), "23514", "agenda_salao_itens_tipo_ck");
  await recusaPor(item(c, s, { grupo: "BRINCADEIRAS", codigo: "BRINQUEDAO", proprio: "Tirolesa" }), "23514", "agenda_salao_itens_tipo_ck");
  await recusaPor(item(c, s, { grupo: "BRINCADEIRAS", proprio: "  Tirolesa" }), "23514", "agenda_salao_itens_proprio_ck");
  await recusaPor(item(c, s, { grupo: "BRINCADEIRAS", proprio: "Tirolesa  gigante" }), "23514", "agenda_salao_itens_proprio_ck");
  const v0 = (await estado(s)).conteudo_versao;
  const brinquedao = await item(c, s, { grupo: "BRINCADEIRAS", codigo: "BRINQUEDAO", detalhe: "3 andares", destaque: true });
  assert.equal((await estado(s)).conteudo_versao, v0 + 1);
  const tirolesa = await item(c, s, { grupo: "BRINCADEIRAS", proprio: "Tirolesa", destaque: true });
  await recusaPor(item(c, s, { grupo: "BRINCADEIRAS", proprio: "TIROLESA" }), "23505", "agenda_salao_itens_proprio_uk");
  await item(c, s, { grupo: "ADULTOS", proprio: "Tirolesa" }); // mesmo texto em outro grupo é outro item
  await recusaPor(item(c, s, { grupo: "BRINCADEIRAS", codigo: "BRINQUEDAO" }), "23505", "agenda_salao_itens_codigo_uk");
  // Identidade imutável: código (mesmo grupo), grupo, tipo próprio↔catálogo e salão.
  await recusaPor(a.query(`UPDATE agenda_salao_itens SET item_codigo = 'CAMA_ELASTICA' WHERE id = $1::uuid`, [brinquedao]), "23514", "agenda_salao_itens_tipo_ck");
  await recusaPor(a.query(`UPDATE agenda_salao_itens SET item_codigo = 'CAMA_ELASTICA', item_proprio = NULL WHERE id = $1::uuid`, [tirolesa]), "23514", "agenda_salao_itens_tipo_ck");
  await recusaPor(a.query(`UPDATE agenda_salao_itens SET grupo = 'ADULTOS' WHERE id = $1::uuid`, [tirolesa]), "23514", "agenda_salao_itens_tipo_ck");
  const outro = await salao(c);
  await recusaPor(a.query(`UPDATE agenda_salao_itens SET salao_id = $2::uuid WHERE id = $1::uuid`, [tirolesa, outro]), "23514", "agenda_salao_itens_tipo_ck");
  // Texto do próprio, detalhe e destaque mudam e invalidam a declaração; no-op não.
  await declarar(s, c.usuario);
  const v = (await estado(s)).conteudo_versao;
  await a.query(`UPDATE agenda_salao_itens SET detalhe = '3 andares' WHERE id = $1::uuid`, [brinquedao]);
  assert.equal((await estado(s)).conteudo_versao, v);
  assert.notEqual((await estado(s)).declaracao_em, null);
  await a.query(`UPDATE agenda_salao_itens SET item_proprio = 'Tirolesa grande' WHERE id = $1::uuid`, [tirolesa]);
  assert.deepEqual(await estado(s), { conteudo_versao: v + 1, declaracao_versao: null, declaracao_em: null });
  // 4 destaques (F1: próprio também conta); o 5º é recusado no INSERT e na promoção.
  await item(c, s, { grupo: "CONFORTO", codigo: "AR_TODOS_AMBIENTES", destaque: true });
  const piso = await item(c, s, { grupo: "ESPACO", codigo: "PISO_UNICO", destaque: true });
  await recusaPor(item(c, s, { grupo: "CONFORTO", codigo: "FRALDARIO", destaque: true }), "23514", "agenda_salao_itens_destaques_ck");
  const fraldario = await item(c, s, { grupo: "CONFORTO", codigo: "FRALDARIO" });
  await recusaPor(a.query(`UPDATE agenda_salao_itens SET destaque = true WHERE id = $1::uuid`, [fraldario]), "23514", "agenda_salao_itens_destaques_ck");
  await a.query(`UPDATE agenda_salao_itens SET destaque = false WHERE id = $1::uuid`, [piso]);
  await a.query(`UPDATE agenda_salao_itens SET destaque = true WHERE id = $1::uuid`, [fraldario]);
  // DELETE invalida; TRUNCATE recusado.
  await declarar(s, c.usuario);
  await a.query(`DELETE FROM agenda_salao_itens WHERE id = $1::uuid`, [piso]);
  assert.equal((await estado(s)).declaracao_em, null);
  await recusaPor(a.query(`TRUNCATE agenda_salao_itens`), "42501");
});

test("102: fotos — lista do que pode mudar, remoção única, DELETE/TRUNCATE recusados, origem, ordem e invalidação", async (t) => {
  if (!so102(t)) return;
  const c = await cenario(a, 0);
  const s = await salao(c);
  const f1 = await foto(c, s, 1);
  const f2 = await foto(c, s, 2);
  await recusaPor(foto(c, s, 2), "23505", "agenda_salao_fotos_ordem_uk");
  const { conteudo, sha } = webp();
  const ins = (extra: string, valores: unknown[]) => a.query(
    `INSERT INTO agenda_salao_fotos (empresa_id, salao_id, conteudo, mime, bytes, largura, altura, sha256, legenda, ordem, origem, origem_sha256, criado_por)
     VALUES ($1::uuid, $2::uuid, $3, 'image/webp', $4, 800, 600, $5, 'Legenda', 9, ${extra}, $6::uuid)`, [c.empresa, s, conteudo, conteudo.length, sha, c.usuario, ...valores]);
  await recusaPor(ins("'SITE', NULL", []), "23514", "agenda_salao_fotos_origem_ck");
  await recusaPor(ins("'UPLOAD', $7", [sha]), "23514", "agenda_salao_fotos_origem_ck");
  await recusaPor(ins("'SITE', 'ABC'", []), "23514", "agenda_salao_fotos_origem_ck");
  await recusaPor(a.query(`INSERT INTO agenda_salao_fotos (empresa_id, salao_id, conteudo, mime, bytes, largura, altura, sha256, legenda, ordem, origem, criado_por)
     VALUES ($1::uuid, $2::uuid, $3, 'image/webp', $4, 800, 600, $5, 'L', 10, 'UPLOAD', $6::uuid)`, [c.empresa, s, conteudo, conteudo.length, "0".repeat(64), c.usuario]),
    "23514", "agenda_salao_fotos_hash_ck");
  await recusaPor(a.query(`INSERT INTO agenda_salao_fotos (empresa_id, salao_id, conteudo, mime, bytes, largura, altura, sha256, legenda, ordem, origem, criado_por)
     VALUES ($1::uuid, $2::uuid, $3, 'image/webp', $4, 1601, 600, $5, 'L', 10, 'UPLOAD', $6::uuid)`, [c.empresa, s, conteudo, conteudo.length, sha, c.usuario]), "23514");
  // Só legenda, ordem e remoção mudam.
  await recusaPor(a.query(`UPDATE agenda_salao_fotos SET conteudo = $2, bytes = $3, sha256 = $4 WHERE id = $1::uuid`, [f1, conteudo, conteudo.length, sha]), "42501");
  await recusaPor(a.query(`UPDATE agenda_salao_fotos SET criado_por = criado_por, origem = 'SITE', origem_sha256 = $2 WHERE id = $1::uuid`, [f1, sha]), "42501");
  await recusaPor(a.query(`UPDATE agenda_salao_fotos SET largura = 700 WHERE id = $1::uuid`, [f1]), "42501");
  await declarar(s, c.usuario);
  const v = (await estado(s)).conteudo_versao;
  await a.query(`UPDATE agenda_salao_fotos SET legenda = 'Foto 1' WHERE id = $1::uuid`, [f1]); // no-op
  assert.equal((await estado(s)).conteudo_versao, v);
  await a.query(`UPDATE agenda_salao_fotos SET legenda = 'Brinquedão' WHERE id = $1::uuid`, [f1]);
  assert.deepEqual(await estado(s), { conteudo_versao: v + 1, declaracao_versao: null, declaracao_em: null });
  await recusaPor(a.query(`UPDATE agenda_salao_fotos SET legenda = '' WHERE id = $1::uuid`, [f1]), "23514");
  // Remoção única; foto removida não muda nem volta; a ordem fica livre para outra.
  await a.query(`UPDATE agenda_salao_fotos SET removida_em = clock_timestamp() WHERE id = $1::uuid`, [f2]);
  await recusaPor(a.query(`UPDATE agenda_salao_fotos SET removida_em = NULL WHERE id = $1::uuid`, [f2]), "42501");
  await recusaPor(a.query(`UPDATE agenda_salao_fotos SET legenda = 'Outra' WHERE id = $1::uuid`, [f2]), "42501");
  await foto(c, s, 2);
  await recusaPor(a.query(`DELETE FROM agenda_salao_fotos WHERE id = $1::uuid`, [f1]), "42501");
  await recusaPor(a.query(`TRUNCATE agenda_salao_fotos`), "42501");
  await recusaPor(foto(c, s, 32001), "23514");
  // Foto removida também não nasce removida.
  await recusaPor(a.query(`INSERT INTO agenda_salao_fotos (empresa_id, salao_id, conteudo, mime, bytes, largura, altura, sha256, legenda, ordem, origem, criado_por, removida_em)
     VALUES ($1::uuid, $2::uuid, $3, 'image/webp', $4, 800, 600, $5, 'L', 11, 'UPLOAD', $6::uuid, clock_timestamp())`, [c.empresa, s, conteudo, conteudo.length, sha, c.usuario]),
    "23514", "agenda_salao_fotos_remocao_ck");
});

test("102: isolamento — salão de outra empresa recusado nas fotos e nos itens (FK composta, SQL direto)", async (t) => {
  if (!so102(t)) return;
  const c1 = await cenario(a, 0);
  const c2 = await cenario(a, 0);
  const s1 = await salao(c1);
  await recusaPor(item({ ...c2 }, s1, { grupo: "CONFORTO", codigo: "WIFI" }), "23503", "agenda_salao_itens_salao_fk");
  await recusaPor(foto({ ...c2 }, s1, 1), "23503", "agenda_salao_fotos_salao_fk");
});

test("102: 8 fotos ativas sob duas conexões reais — a segunda espera o salão e é recusada depois do commit", async (t) => {
  if (!so102(t)) return;
  const c = await cenario(a, 0);
  const s = await salao(c);
  for (let i = 1; i <= 7; i++) await foto(c, s, i);
  const b = await conectarDescartavel({ travar: false });
  try {
    const pidA = (await a.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p;
    const pidB = (await b.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p;
    await a.query("BEGIN");
    await foto(c, s, 8); // 7 → 8 na conexão A, sem commit (salão travado)
    await b.query("BEGIN");
    const segunda = foto(c, s, 9, b).then(() => "ok", (e: { code?: string; constraint?: string }) => `${e.code}:${e.constraint}`);
    await esperarBloqueio(pidA, pidB);
    await a.query("COMMIT");
    assert.equal(await segunda, "23514:agenda_salao_fotos_limite_ck");
    await b.query("ROLLBACK");
    // Com o concorrente desfeito, a vaga continua disponível.
    await a.query("BEGIN");
    await a.query(`UPDATE agenda_salao_fotos SET removida_em = clock_timestamp() WHERE salao_id = $1::uuid AND ordem = 8`, [s]);
    await b.query("BEGIN");
    const terceira = foto(c, s, 9, b).then(() => "ok", (e: { code?: string }) => String(e.code));
    await esperarBloqueio(pidA, pidB);
    await a.query("ROLLBACK");
    assert.equal(await terceira, "23514");
    await b.query("ROLLBACK");
  } finally {
    await b.end();
  }
});

test("102: 4 destaques sob duas conexões reais — a segunda promoção espera e é recusada depois do commit", async (t) => {
  if (!so102(t)) return;
  const c = await cenario(a, 0);
  const s = await salao(c);
  for (const codigo of ["BRINQUEDAO", "CAMA_ELASTICA", "PISCINA_BOLINHAS"]) await item(c, s, { grupo: "BRINCADEIRAS", codigo, destaque: true });
  const b = await conectarDescartavel({ travar: false });
  try {
    const pidA = (await a.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p;
    const pidB = (await b.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p;
    await a.query("BEGIN");
    await item(c, s, { grupo: "CONFORTO", codigo: "WIFI", destaque: true }); // 3 → 4
    await b.query("BEGIN");
    const segunda = item(c, s, { grupo: "CONFORTO", codigo: "FRALDARIO", destaque: true }, b)
      .then(() => "ok", (e: { code?: string; constraint?: string }) => `${e.code}:${e.constraint}`);
    await esperarBloqueio(pidA, pidB);
    await a.query("COMMIT");
    assert.equal(await segunda, "23514:agenda_salao_itens_destaques_ck");
    await b.query("ROLLBACK");
  } finally {
    await b.end();
  }
});
