import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import pg, { type Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, portaDescartavel, senhaRecusada } from "../comercial/postgres-descartavel.ts";
import { carregarComBanco, executor } from "../marketing/harness-postgres.ts";
import { lerConfigLegada, salvarConfigLegada } from "./config-legada-armazem.ts";

/**
 * 128 (dados do disco persistente no banco; vault "Convites geracao sobrevive ao deploy 20261120", fase 2) no PostgreSQL
 * DESCARTÁVEL recriado do modelo 128. Dados 100% sintéticos (PDF mínimo gerado aqui).
 *   - travas do banco: uma linha só, forma do jsonb, origem; bytes do PDF conferidos contra tamanho e sha256;
 *   - armazém das regras legadas: sem linha lê o arquivo, grava no banco (PAINEL), depois lê o banco; trava a linha;
 *   - PDF público: publicar com a coluna não grava no disco; ler devolve os bytes do banco e recusa divergência;
 *   - script de cópia (scripts/disco-para-banco-128.cjs): conferir só lê; sem arquivo e sem linha é PROBLEMA; copiar
 *     preenche config (DISCO) e PDF, atualiza a linha DISCO quando o arquivo muda, não sobrescreve o que o painel gravou,
 *     recusa PDF divergente sem gravar nada e repetir não muda nada;
 *   - ciclo: precheck e up recusam com a 128; down recusa sem a confirmação; com ela remove; precheck, up e postcheck.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
const ler = (r: string) => readFileSync(new URL(`../../${r}`, import.meta.url), "utf8");
const UP = "database/migrations/20261120_128_dados_fora_do_disco.sql";
const DOWN = "database/rollback/20261120_128_dados_fora_do_disco_down.sql";
const PRE = "database/checks/20261120_128_precheck.sql";
const POS = "database/checks/20261120_128_postcheck.sql";
const require = createRequire(import.meta.url);
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const pdf = (texto: string) => Buffer.from(`%PDF-1.4\n% ${texto}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`, "latin1");
const TIPO = "TABELA_PACOTES_PRECOS";

type Copia = {
  principal(argv: string[], env: Record<string, string>, deps: Record<string, unknown>): Promise<{ codigo: number; saida: Record<string, unknown> & { pendentes?: { config: boolean; pdfs: number }; problemas?: string[] } }>;
};
type Doc = { publicarPdf(b: Buffer, n: string): Promise<{ id: string; sha256: string }>; lerPdfVigente(tx?: unknown): Promise<{ bytes: Buffer } | null> };

async function recusa(c: Client, sql: string, params: unknown[], padrao: RegExp) {
  await c.query("SAVEPOINT recusa");
  await assert.rejects(c.query(sql, params), padrao);
  await c.query("ROLLBACK TO SAVEPOINT recusa");
}
async function documento(c: Client, bytes: Buffer, chave: string, ativo = true) {
  await c.query("UPDATE documentos_publicos SET ativo = false WHERE tipo = $1 AND ativo", [TIPO]);
  return (await c.query<{ id: string }>(`INSERT INTO documentos_publicos (tipo, nome_arquivo, mime_type, tamanho_bytes, sha256, chave_armazenamento, ativo, publicado_em)
    VALUES ($1, 'tabela.pdf', 'application/pdf', $2, $3, $4, $5, clock_timestamp()) RETURNING id::text AS id`, [TIPO, bytes.length, sha(bytes), chave, ativo])).rows[0].id;
}

test("128: postcheck no modelo; travas da tabela e da coluna", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    await c.query(ler(POS));
    await c.query("BEGIN");
    await recusa(c, "INSERT INTO disponibilidade_config_legada (id, conteudo, origem) VALUES (2, '{\"pacoteOverrides\":[],\"descontos\":[]}', 'DISCO')", [], /disponibilidade_config_legada_unica/);
    await recusa(c, "INSERT INTO disponibilidade_config_legada (conteudo, origem) VALUES ('[]', 'DISCO')", [], /disponibilidade_config_legada_forma/);
    await recusa(c, "INSERT INTO disponibilidade_config_legada (conteudo, origem) VALUES ('{\"pacoteOverrides\":[]}', 'DISCO')", [], /disponibilidade_config_legada_forma/);
    await recusa(c, "INSERT INTO disponibilidade_config_legada (conteudo, origem) VALUES ('{\"pacoteOverrides\":[],\"descontos\":[]}', 'OUTRA')", [], /disponibilidade_config_legada_origem/);
    await c.query("INSERT INTO disponibilidade_config_legada (conteudo, origem) VALUES ('{\"pacoteOverrides\":[],\"descontos\":[]}', 'DISCO')");
    await recusa(c, "INSERT INTO disponibilidade_config_legada (conteudo, origem) VALUES ('{\"pacoteOverrides\":[],\"descontos\":[]}', 'PAINEL')", [], /disponibilidade_config_legada_pkey/);

    const bytes = pdf("trava");
    const id = await documento(c, bytes, "00000000-0000-4000-8000-000000000128.pdf");
    await recusa(c, "UPDATE documentos_publicos SET conteudo = $1 WHERE id = $2::uuid", [pdf("outro"), id], /documentos_publicos_conteudo_confere/);
    await recusa(c, "UPDATE documentos_publicos SET conteudo = $1 WHERE id = $2::uuid", [Buffer.concat([bytes, Buffer.from(" ")]), id], /documentos_publicos_conteudo_confere/);
    await c.query("UPDATE documentos_publicos SET conteudo = $1 WHERE id = $2::uuid", [bytes, id]);
    await recusa(c, "UPDATE documentos_publicos SET sha256 = $1 WHERE id = $2::uuid", [sha("x"), id], /documentos_publicos_conteudo_confere/);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(c);
  }
});

test("128: armazém das regras legadas (arquivo → banco, PAINEL, trava) e PDF público pelo banco", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const pasta = mkdtempSync(path.join(os.tmpdir(), "kidmais-128-"));
  try {
    await c.query("BEGIN");
    const tx = executor(c);
    const arquivo = path.join(pasta, "disponibilidade.json");
    assert.deepEqual(await lerConfigLegada(tx, { arquivo }), { pacoteOverrides: [], descontos: [] }, "sem linha e sem arquivo: vazio");
    writeFileSync(arquivo, JSON.stringify({ pacoteOverrides: [{ id: "P_DISCO" }], descontos: [], outro: 1 }));
    assert.deepEqual(await lerConfigLegada(tx, { arquivo }), { pacoteOverrides: [{ id: "P_DISCO" }], descontos: [] }, "sem linha: o arquivo");
    assert.equal(await salvarConfigLegada(tx, { pacoteOverrides: [{ id: "P_PAINEL" }], descontos: [{ d: 1 }] }, { arquivo }), "BANCO");
    assert.deepEqual(JSON.parse(readFileSync(arquivo, "utf8")).pacoteOverrides, [{ id: "P_DISCO" }], "com a 128 o arquivo não é tocado");
    assert.deepEqual(await lerConfigLegada(tx, { arquivo }), { pacoteOverrides: [{ id: "P_PAINEL" }], descontos: [{ d: 1 }] }, "com linha: o banco");
    assert.equal((await c.query("SELECT origem FROM disponibilidade_config_legada")).rows[0].origem, "PAINEL");

    const doc = carregarComBanco("lib/catalogo/documento-publico.ts", c, () => null) as unknown as Doc;
    const antes = existsSync(path.join(process.cwd(), "data", "documentos-publicos"));
    const bytes = pdf("publicado");
    const publicado = await doc.publicarPdf(bytes, "tabela.pdf");
    assert.equal(publicado.sha256, sha(bytes));
    assert.equal(existsSync(path.join(process.cwd(), "data", "documentos-publicos")), antes, "com a coluna, nada é gravado no disco");
    assert.ok((await doc.lerPdfVigente(tx))?.bytes.equals(bytes), "lê os bytes do banco");
    // Linha sem bytes e chave fora do padrão: sem disco, null (nunca caminho arbitrário).
    await documento(c, pdf("sem-bytes"), "../fora.pdf");
    assert.equal(await doc.lerPdfVigente(tx), null);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(c);
    rmSync(pasta, { recursive: true, force: true });
  }
});

/**
 * Duas conexões: a abre com a trava do harness; b só disputa a linha. b abre dentro do try, então uma falha ao abrir b
 * ainda encerra a (e libera a trava do harness); a é encerrada mesmo que encerrar b falhe.
 */
async function comDuasConexoes<C>(abrirA: () => Promise<C>, abrirB: () => Promise<C>,
    encerrar: (c: C, travou: boolean) => Promise<void>, trabalho: (a: C, b: C) => Promise<void>) {
  const a = await abrirA();
  let b: C | null = null;
  try {
    b = await abrirB();
    await trabalho(a, b);
  } finally {
    try { if (b !== null) await encerrar(b, false); } finally { await encerrar(a, true); }
  }
}

test("duas conexões: falha ao abrir b encerra a (com a trava); falha no trabalho ou ao encerrar b encerra a", async () => {
  const encerradas: string[] = [];
  const encerrar = async (c: string, travou: boolean) => { encerradas.push(`${c}:${travou}`); if (c === "b!") throw new Error("b não fechou"); };
  await assert.rejects(comDuasConexoes(async () => "a", async () => { throw new Error("b não abriu"); }, encerrar, async () => {}), /b não abriu/);
  assert.deepEqual(encerradas, ["a:true"], "a encerrada mesmo sem b");
  encerradas.length = 0;
  await assert.rejects(comDuasConexoes(async () => "a", async () => "b", encerrar, async () => { throw new Error("trabalho"); }), /trabalho/);
  assert.deepEqual(encerradas, ["b:false", "a:true"]);
  encerradas.length = 0;
  await assert.rejects(comDuasConexoes(async () => "a", async () => "b!", encerrar, async () => {}), /b não fechou/);
  assert.deepEqual(encerradas, ["b!:false", "a:true"], "a encerrada mesmo se encerrar b falhar");
});

test("128: leitura para gravar trava a linha (contenção vista por outra conexão); leitura comum não trava", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  // b sem a trava de teste: a trava fica com a; b só disputa a linha.
  await comDuasConexoes<Client>(() => conectarDescartavel(), () => conectarDescartavel({ travar: false }), encerrarDescartavel, async (a, b) => {
  const outra = () => b.query("SELECT 1 FROM disponibilidade_config_legada WHERE id = 1 FOR UPDATE NOWAIT");
  try {
    await a.query("DELETE FROM disponibilidade_config_legada");
    await a.query("INSERT INTO disponibilidade_config_legada (conteudo, origem) VALUES ('{\"pacoteOverrides\":[{\"id\":\"P\"}],\"descontos\":[]}', 'PAINEL')");
    await a.query("BEGIN");
    assert.deepEqual(await lerConfigLegada(executor(a), { travar: true }), { pacoteOverrides: [{ id: "P" }], descontos: [] });
    await b.query("BEGIN");
    await assert.rejects(outra(), (e: { code?: string }) => e.code === "55P03", "a outra conexão não obtém a linha");
    await b.query("ROLLBACK");
    await a.query("ROLLBACK");

    await a.query("BEGIN");
    await lerConfigLegada(executor(a), {});
    await b.query("BEGIN");
    await outra();
    await b.query("ROLLBACK");
    await a.query("ROLLBACK");
  } finally {
    await a.query("ROLLBACK").catch(() => undefined);
    await b.query("ROLLBACK").catch(() => undefined);
    await a.query("DELETE FROM disponibilidade_config_legada").catch(() => undefined);
  }
  });
});

test("128: script de cópia — conferir só lê; copiar preenche, não sobrescreve o painel, recusa divergência e repete sem mudar", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const disco = mkdtempSync(path.join(os.tmpdir(), "kidmais-128-disco-"));
  try {
    const banco = (await c.query<{ db: string }>("SELECT current_database() AS db")).rows[0].db;
    const copia = require("../../scripts/disco-para-banco-128.cjs") as Copia;
    // Alvo = o próprio cluster descartável; a identidade de staging/production é testada no teste unitário do script.
    const amb = { nome: "descartavel", cfg: { host: "127.0.0.1", port: portaDescartavel(), user: "kidmais_descartavel", database: banco, password: senhaRecusada },
      sqlIdentidade: "SELECT current_database() AS db", identidade: (id: { db: string }) => { assert.equal(id.db, banco); return { banco: id.db }; } };
    const deps = { amb, disco, Client: pg.Client, exigirDisco: () => undefined };
    const rodar = (flag: string) => copia.principal([flag, "staging"], { KIDMAIS_DEPLOY_ENV: "staging" }, deps);

    await c.query("DELETE FROM disponibilidade_config_legada");
    await c.query("UPDATE documentos_publicos SET ativo = false WHERE tipo = $1 AND ativo", [TIPO]);
    const bytes = pdf("disco");
    const chave = "11111111-1111-4111-8111-111111111128.pdf";
    const id = await documento(c, bytes, chave);
    mkdirSync(path.join(disco, "documentos-publicos"));
    writeFileSync(path.join(disco, "documentos-publicos", chave), bytes);
    let r = await rodar("--conferir-128");
    assert.equal(r.codigo, 3, "sem arquivo e sem linha: a agenda ficaria sem regras depois do disco");
    assert.deepEqual(r.saida.problemas, ["CONFIG_AUSENTE_SEM_LINHA"]);
    r = await rodar("--copiar-128-autorizado");
    assert.equal(r.codigo, 2);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM documentos_publicos WHERE conteudo IS NOT NULL")).rows[0].n, 0, "nem o PDF entra");
    writeFileSync(path.join(disco, "disponibilidade.json"), JSON.stringify({ pacoteOverrides: [{ id: "P1" }], descontos: [{ id: "D1" }] }));

    r = await rodar("--conferir-128");
    assert.equal(r.codigo, 0);
    assert.equal(r.saida.situacao, "PRONTO_PARA_COPIAR");
    assert.deepEqual(r.saida.pendentes, { config: true, pdfs: 1 });
    assert.equal((await c.query("SELECT count(*)::int AS n FROM disponibilidade_config_legada")).rows[0].n, 0, "conferir não grava");
    assert.ok(!JSON.stringify(r.saida).includes("P1"), "a saída não traz conteúdo");

    // PDF divergente no disco: recusa, ROLLBACK, nem a config entra.
    writeFileSync(path.join(disco, "documentos-publicos", chave), pdf("adulterado"));
    r = await rodar("--conferir-128");
    assert.equal(r.codigo, 3);
    assert.deepEqual(r.saida.problemas, [`PDF_DIVERGENTE ${id}`]);
    r = await rodar("--copiar-128-autorizado");
    assert.equal(r.codigo, 2);
    assert.match(String(r.saida.mensagem), /PDF_DIVERGENTE/);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM disponibilidade_config_legada")).rows[0].n, 0, "falha: nada gravado");

    writeFileSync(path.join(disco, "documentos-publicos", chave), bytes);
    r = await rodar("--copiar-128-autorizado");
    assert.equal(r.codigo, 0, JSON.stringify(r.saida));
    assert.equal(r.saida.configCopiada, true);
    assert.equal(r.saida.pdfsCopiados, 1);
    assert.equal(r.saida.releitura, "APOS_COMMIT");
    assert.equal(r.saida.situacao, "NADA_A_COPIAR", "o resumo final vem da releitura depois do COMMIT");
    const linha = (await c.query("SELECT conteudo, origem FROM disponibilidade_config_legada")).rows[0];
    assert.deepEqual([linha.conteudo, linha.origem], [{ pacoteOverrides: [{ id: "P1" }], descontos: [{ id: "D1" }] }, "DISCO"]);
    assert.ok((await c.query("SELECT conteudo FROM documentos_publicos WHERE id = $1::uuid", [id])).rows[0].conteudo.equals(bytes));

    // O arquivo muda depois da cópia (o web antigo ainda gravava nele): a linha DISCO é atualizada.
    writeFileSync(path.join(disco, "disponibilidade.json"), JSON.stringify({ pacoteOverrides: [{ id: "P2" }], descontos: [] }));
    r = await rodar("--conferir-128");
    assert.deepEqual([r.saida.situacao, r.saida.pendentes], ["PRONTO_PARA_COPIAR", { config: true, pdfs: 0 }]);
    r = await rodar("--copiar-128-autorizado");
    assert.deepEqual([r.codigo, r.saida.configCopiada, r.saida.situacao], [0, true, "NADA_A_COPIAR"]);
    assert.deepEqual((await c.query("SELECT conteudo FROM disponibilidade_config_legada")).rows[0].conteudo, { pacoteOverrides: [{ id: "P2" }], descontos: [] });
    r = await rodar("--copiar-128-autorizado");
    assert.equal(r.saida.configCopiada, false, "arquivo igual à linha: nada muda");

    // O painel grava depois; o arquivo muda; repetir a cópia não sobrescreve nada.
    await c.query("UPDATE disponibilidade_config_legada SET conteudo = '{\"pacoteOverrides\":[],\"descontos\":[]}', origem = 'PAINEL'");
    writeFileSync(path.join(disco, "disponibilidade.json"), JSON.stringify({ pacoteOverrides: [{ id: "VELHO" }], descontos: [] }));
    r = await rodar("--copiar-128-autorizado");
    assert.equal(r.codigo, 0);
    assert.equal(r.saida.configCopiada, false);
    assert.equal(r.saida.pdfsCopiados, 0);
    assert.equal((await c.query("SELECT origem FROM disponibilidade_config_legada")).rows[0].origem, "PAINEL");
    r = await rodar("--conferir-128");
    assert.equal(r.saida.situacao, "NADA_A_COPIAR");
  } finally {
    await c.query("DELETE FROM disponibilidade_config_legada").catch(() => undefined);
    await c.query("UPDATE documentos_publicos SET conteudo = NULL, ativo = false WHERE tipo = $1", [TIPO]).catch(() => undefined);
    await encerrarDescartavel(c);
    rmSync(disco, { recursive: true, force: true });
  }
});

test("128: precheck e up recusam com a 128; down só com a confirmação; precheck, up e postcheck de novo", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    await assert.rejects(c.query(ler(PRE)), /128 já presente/);
    await c.query("ROLLBACK").catch(() => undefined);
    await assert.rejects(c.query(ler(UP)), /128: já presente/);
    await c.query("ROLLBACK").catch(() => undefined);
    await assert.rejects(c.query(ler(DOWN)), /falta SET kidmais.rollback_128/);
    await c.query("ROLLBACK").catch(() => undefined);
    assert.equal((await c.query("SELECT to_regclass('public.disponibilidade_config_legada') IS NOT NULL AS ok")).rows[0].ok, true, "sem confirmação nada muda");
    await c.query("SET kidmais.rollback_128 = 'descartar-copias'");
    await c.query(ler(DOWN));
    await c.query("RESET kidmais.rollback_128");
    assert.equal((await c.query(`SELECT to_regclass('public.disponibilidade_config_legada') IS NULL
      AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.documentos_publicos'::regclass AND attname = 'conteudo' AND NOT attisdropped)
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documentos_publicos_conteudo_confere') AS ok`)).rows[0].ok, true);
    // Sem a 128 o código volta ao disco: o armazém grava o arquivo (testado no unitário) e o PDF não tem a coluna.
    await c.query(ler(PRE));
    await c.query(ler(UP));
    await c.query(ler(POS));

    // Postcheck recusa PK diferível e CHECK homônimo com outro predicado (cada troca é desfeita em seguida).
    const divergente = async (troca: string, desfaz: string, padrao: RegExp) => {
      await c.query(troca);
      try { await assert.rejects(c.query(ler(POS)), padrao); await c.query("ROLLBACK").catch(() => undefined); }
      finally { await c.query(desfaz); }
    };
    await divergente(
      "ALTER TABLE disponibilidade_config_legada DROP CONSTRAINT disponibilidade_config_legada_pkey, ADD CONSTRAINT disponibilidade_config_legada_pkey PRIMARY KEY (id) DEFERRABLE",
      "ALTER TABLE disponibilidade_config_legada DROP CONSTRAINT disponibilidade_config_legada_pkey, ADD CONSTRAINT disponibilidade_config_legada_pkey PRIMARY KEY (id)",
      /ausente ou diferível/);
    await divergente(
      "ALTER TABLE disponibilidade_config_legada DROP CONSTRAINT disponibilidade_config_legada_origem, ADD CONSTRAINT disponibilidade_config_legada_origem CHECK (origem IN ('DISCO', 'PAINEL', 'OUTRA'))",
      "ALTER TABLE disponibilidade_config_legada DROP CONSTRAINT disponibilidade_config_legada_origem, ADD CONSTRAINT disponibilidade_config_legada_origem CHECK (origem IN ('DISCO', 'PAINEL'))",
      /definição divergente/);
    // Espaço dentro do literal: a comparação exata não o remove (com 'PAINEL ' a gravação de 'PAINEL' seria recusada).
    await divergente(
      "ALTER TABLE disponibilidade_config_legada DROP CONSTRAINT disponibilidade_config_legada_origem, ADD CONSTRAINT disponibilidade_config_legada_origem CHECK (origem IN ('DISCO', 'PAINEL '))",
      "ALTER TABLE disponibilidade_config_legada DROP CONSTRAINT disponibilidade_config_legada_origem, ADD CONSTRAINT disponibilidade_config_legada_origem CHECK (origem IN ('DISCO', 'PAINEL'))",
      /definição divergente/);
    // Agrupamento diferente com os mesmos tokens: (a AND b) OR c no lugar de a OR (b AND c).
    await divergente(
      "ALTER TABLE documentos_publicos DROP CONSTRAINT documentos_publicos_conteudo_confere, ADD CONSTRAINT documentos_publicos_conteudo_confere CHECK ((conteudo IS NULL OR octet_length(conteudo) = tamanho_bytes) AND encode(sha256(conteudo), 'hex') = sha256)",
      "ALTER TABLE documentos_publicos DROP CONSTRAINT documentos_publicos_conteudo_confere, ADD CONSTRAINT documentos_publicos_conteudo_confere CHECK (conteudo IS NULL OR (octet_length(conteudo) = tamanho_bytes AND encode(sha256(conteudo), 'hex') = sha256))",
      /definição divergente/);
    await divergente(
      "ALTER TABLE documentos_publicos DROP CONSTRAINT documentos_publicos_conteudo_confere, ADD CONSTRAINT documentos_publicos_conteudo_confere CHECK (conteudo IS NULL OR octet_length(conteudo) = tamanho_bytes)",
      "ALTER TABLE documentos_publicos DROP CONSTRAINT documentos_publicos_conteudo_confere, ADD CONSTRAINT documentos_publicos_conteudo_confere CHECK (conteudo IS NULL OR (octet_length(conteudo) = tamanho_bytes AND encode(sha256(conteudo), 'hex') = sha256))",
      /definição divergente/);
    await c.query(ler(POS));
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(c);
  }
});
