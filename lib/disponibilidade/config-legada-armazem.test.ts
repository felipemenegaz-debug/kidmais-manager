import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { lerConfigLegada, salvarConfigLegada } from "./config-legada-armazem.ts";
import type { DbExecutor } from "../db/contracts.ts";

/**
 * Armazém das regras legadas da agenda SEM a 128 (o caminho com o banco está em migration-128.postgres.test.ts):
 * arquivo como antes, nenhuma escrita no banco, forma normalizada e arquivo ilegível lido como vazio.
 */
function semA128() {
  const consultas: string[] = [];
  const tx: DbExecutor = { async query(sql: string) { consultas.push(sql); return { rows: [{ ok: false }], rowCount: 1 } as never; } };
  return { tx, consultas };
}

test("sem a 128: lê e grava o arquivo; o banco só é consultado sobre a tabela", async (t) => {
  const pasta = mkdtempSync(path.join(os.tmpdir(), "armazem-128-"));
  t.after(() => rmSync(pasta, { recursive: true, force: true }));
  const arquivo = path.join(pasta, "sub", "disponibilidade.json");
  const { tx, consultas } = semA128();
  assert.deepEqual(await lerConfigLegada(tx, { arquivo }), { pacoteOverrides: [], descontos: [] });
  assert.equal(await salvarConfigLegada(tx, { pacoteOverrides: [{ id: "P" }], descontos: [] }, { arquivo }), "ARQUIVO");
  assert.deepEqual(JSON.parse(readFileSync(arquivo, "utf8")), { pacoteOverrides: [{ id: "P" }], descontos: [] });
  assert.deepEqual(await lerConfigLegada(tx, { arquivo, travar: true }), { pacoteOverrides: [{ id: "P" }], descontos: [] });
  assert.ok(consultas.every((q) => q.includes("to_regclass")), "nenhum SELECT/INSERT na tabela");
  writeFileSync(arquivo, "{quebrado");
  assert.deepEqual(await lerConfigLegada(tx, { arquivo }), { pacoteOverrides: [], descontos: [] });
  writeFileSync(arquivo, JSON.stringify({ pacoteOverrides: "x", descontos: [{ d: 1 }] }));
  assert.deepEqual(await lerConfigLegada(tx, { arquivo }), { pacoteOverrides: [], descontos: [{ d: 1 }] });
  writeFileSync(arquivo, JSON.stringify({ pacoteOverrides: [null, { id: "P" }, 3, [1]], descontos: [] }));
  assert.deepEqual(await lerConfigLegada(tx, { arquivo }), { pacoteOverrides: [{ id: "P" }], descontos: [] }, "leitura: item inválido sai, válidos ficam");
});

test("sem a 128, leitura para gravar (entre o deploy e a 128): arquivo ruim é recusado, não vira vazio", async (t) => {
  const pasta = mkdtempSync(path.join(os.tmpdir(), "armazem-128c-"));
  t.after(() => rmSync(pasta, { recursive: true, force: true }));
  const arquivo = path.join(pasta, "disponibilidade.json");
  const { tx } = semA128();
  const recusa = (codigo: string) => (e: { code?: string; httpStatus?: number }) => e.code === codigo && e.httpStatus === 409;
  await assert.rejects(lerConfigLegada(tx, { arquivo, travar: true, env: { RENDER: "true" } }), recusa("CONFIG_LEGADA_AUSENTE"));
  for (const ruim of ["{quebrado", "[1]", JSON.stringify({ descontos: { a: 1 } }), JSON.stringify({ pacoteOverrides: [null] }), JSON.stringify({ pacoteOverrides: [{ id: "P" }, "x"] })]) {
    writeFileSync(arquivo, ruim);
    await assert.rejects(lerConfigLegada(tx, { arquivo, travar: true, env: { RENDER: "true" } }), recusa("CONFIG_LEGADA_ILEGIVEL"), ruim);
  }
  writeFileSync(arquivo, JSON.stringify({ pacoteOverrides: [{ id: "P" }] }));
  assert.deepEqual(await lerConfigLegada(tx, { arquivo, travar: true, env: { RENDER: "true" } }), { pacoteOverrides: [{ id: "P" }], descontos: [] }, "campo ausente = []");
});

/** Com a 128 instalada e sem a linha: a tabela existe, o SELECT da linha volta vazio. */
function comA128SemLinha() {
  const consultas: string[] = [];
  const tx: DbExecutor = { async query(sql: string) {
    consultas.push(sql);
    return (sql.includes("to_regclass") ? { rows: [{ ok: true }], rowCount: 1 } : { rows: [], rowCount: 0 }) as never;
  } };
  return { tx, consultas };
}

test("com a 128 e sem linha: leitura para gravar recusa arquivo ilegível e, na Render, ausente; leitura comum segue tolerante", async (t) => {
  const pasta = mkdtempSync(path.join(os.tmpdir(), "armazem-128b-"));
  t.after(() => rmSync(pasta, { recursive: true, force: true }));
  const arquivo = path.join(pasta, "disponibilidade.json");
  const { tx, consultas } = comA128SemLinha();
  const recusa = (codigo: string) => (e: { code?: string; httpStatus?: number }) => e.code === codigo && e.httpStatus === 409;

  await assert.rejects(lerConfigLegada(tx, { arquivo, travar: true, env: { RENDER: "true" } }), recusa("CONFIG_LEGADA_AUSENTE"));
  assert.deepEqual(await lerConfigLegada(tx, { arquivo, travar: true, env: {} }), { pacoteOverrides: [], descontos: [] }, "local sem arquivo");
  writeFileSync(arquivo, "{quebrado");
  await assert.rejects(lerConfigLegada(tx, { arquivo, travar: true, env: {} }), recusa("CONFIG_LEGADA_ILEGIVEL"));
  writeFileSync(arquivo, "[1]");
  await assert.rejects(lerConfigLegada(tx, { arquivo, travar: true, env: {} }), recusa("CONFIG_LEGADA_ILEGIVEL"));
  writeFileSync(arquivo, JSON.stringify({ pacoteOverrides: [], descontos: { a: 1 } }));
  await assert.rejects(lerConfigLegada(tx, { arquivo, travar: true, env: {} }), recusa("CONFIG_LEGADA_ILEGIVEL"), "campo presente que não é lista");
  assert.deepEqual(await lerConfigLegada(tx, { arquivo }), { pacoteOverrides: [], descontos: [] }, "leitura comum tolerante");
  writeFileSync(arquivo, JSON.stringify({ pacoteOverrides: [{ id: "P" }], descontos: [] }));
  assert.deepEqual(await lerConfigLegada(tx, { arquivo, travar: true, env: { RENDER: "true" } }), { pacoteOverrides: [{ id: "P" }], descontos: [] });
  assert.ok(consultas.some((q) => q.includes("WHERE id = 1 FOR UPDATE")), "a linha é travada antes de cair no arquivo");
});

test("com a 128 e linha no banco: leitura para gravar confere a linha sem tolerância; leitura comum filtra", async () => {
  const linha = (conteudo: unknown) => ({ async query(sql: string) {
    return (sql.includes("to_regclass") ? { rows: [{ ok: true }], rowCount: 1 } : { rows: [{ conteudo }], rowCount: 1 }) as never;
  } }) as DbExecutor;
  const recusa = (e: { code?: string; httpStatus?: number }) => e.code === "CONFIG_LEGADA_ILEGIVEL" && e.httpStatus === 409;
  for (const ruim of [{ pacoteOverrides: [], descontos: [null] }, { pacoteOverrides: [{ id: "P" }, 3], descontos: [] }, { descontos: { a: 1 } }, [1]]) {
    await assert.rejects(lerConfigLegada(linha(ruim), { travar: true }), recusa, JSON.stringify(ruim));
  }
  assert.deepEqual(await lerConfigLegada(linha({ pacoteOverrides: [], descontos: [null, { d: 1 }] }), {}), { pacoteOverrides: [], descontos: [{ d: 1 }] }, "leitura comum: o item inválido sai");
  assert.deepEqual(await lerConfigLegada(linha({ pacoteOverrides: [{ id: "P" }] }), { travar: true }), { pacoteOverrides: [{ id: "P" }], descontos: [] }, "linha válida, campo ausente = []");
});
