import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  criarCategoriaBuffet, criarItemBuffet, editarCategoriaBuffet, editarItemBuffet, excluirCategoriaBuffet, excluirItemBuffet, lerCatalogoBuffet,
} from "./catalogo-buffet.ts";
import { PacoteAdminError } from "./pacotes-admin.ts";
import type { DbExecutor, DbQueryResult } from "../db/contracts.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM = "11111111-1111-4111-8111-111111111111";
const CATEGORIA = "22222222-2222-4222-8222-222222222222";

/** Banco falso por empresa: a linha ITEM/CATEGORIA pertence à empresa `dona`; consultas registradas com parâmetros. */
function banco(dona: string, uso = 0) {
  const consultas: Array<{ sql: string; params: readonly unknown[] }> = [];
  const tx: DbExecutor = { async query<Row extends object>(text: string, values: readonly unknown[] = []): Promise<DbQueryResult<Row>> {
    consultas.push({ sql: text, params: values });
    const daEmpresa = values.includes(dona);
    if (/^\s*SELECT (1|categoria_id|id) FROM buffet_(categorias|itens) WHERE id = \$1::uuid AND empresa_id = \$2::uuid/.test(text))
      return { rows: daEmpresa ? [{ categoria_id: null, id: values[0] } as Row] : [], rowCount: daEmpresa ? 1 : 0 };
    if (text.includes("count(*)")) return { rows: [{ n: uso } as Row], rowCount: 1 };
    if (/^\s*(INSERT|UPDATE|DELETE)/.test(text)) return { rows: [{ id: ITEM } as Row], rowCount: daEmpresa || text.trimStart().startsWith("INSERT") ? 1 : 0 };
    if (text.includes("FROM buffet_categorias") || text.includes("FROM buffet_itens")) return { rows: [], rowCount: 0 };
    throw new Error(text);
  } };
  return { tx, consultas };
}

const naoEncontrado = (error: unknown) => error instanceof PacoteAdminError && error.httpStatus === 404;

test("o down 050 trava antes de checar e antes de apagar", () => {
  const sql = readFileSync("database/rollback/20260927_050_item_sem_categoria_down.sql", "utf8");
  const trava = sql.indexOf("kidmais-050-down");
  const checagem = sql.indexOf("categoria_id IS NULL");
  const queda = sql.indexOf("DROP TABLE");
  assert.equal(trava >= 0 && trava < checagem && checagem < queda, true);
  assert.equal(sql.indexOf("LOCK TABLE public.buffet_itens") < checagem, true);
  assert.equal(sql.includes("LOCK TABLE public.pacote_itens_especificos"), true);
});

test("toda operação exige a empresa comprovada (UUID); sem ela, recusa antes de qualquer SQL", async () => {
  const { tx, consultas } = banco(A);
  for (const chamada of [
    () => lerCatalogoBuffet(tx, ""), () => criarCategoriaBuffet(tx, "x", "Bolo"), () => criarItemBuffet(tx, "", "Taxa", null),
    () => editarCategoriaBuffet(tx, "null", CATEGORIA, "x", true), () => excluirItemBuffet(tx, "kidmais", ITEM),
  ]) await assert.rejects(chamada, (e: unknown) => e instanceof PacoteAdminError && e.code === "EMPRESA_OBRIGATORIA");
  assert.equal(consultas.length, 0);
});

test("leitura, criação e escrita filtram por empresa_id; registro de outra empresa = 404, nada alterado", async () => {
  const { tx, consultas } = banco(A);
  await lerCatalogoBuffet(tx, B);
  assert.ok(consultas.every((c) => /WHERE empresa_id = \$1::uuid/.test(c.sql) && c.params[0] === B), "leitura só da empresa pedida");
  consultas.length = 0;
  await criarCategoriaBuffet(tx, B, "Salgados", true, "SALGADOS");
  const insercao = consultas.find((c) => c.sql.startsWith("INSERT INTO buffet_categorias"))!;
  assert.match(insercao.sql, /\(empresa_id, codigo, nome, ativo, arquivado_em\)/);
  assert.equal(insercao.params[0], B);
  assert.equal(insercao.params[1], "SALGADOS", "mesmo código permitido em outra empresa");
  for (const chamada of [
    () => editarCategoriaBuffet(tx, B, CATEGORIA, "Outro nome", true),
    () => excluirCategoriaBuffet(tx, B, CATEGORIA),
    () => editarItemBuffet(tx, B, ITEM, "Outro", undefined, true),
    () => excluirItemBuffet(tx, B, ITEM),
  ]) await assert.rejects(chamada, naoEncontrado);
  await assert.rejects(() => criarItemBuffet(tx, B, "Coxinha", CATEGORIA), (e: unknown) => e instanceof PacoteAdminError && e.code === "DADOS_INVALIDOS");
  assert.ok(!consultas.some((c) => /^\s*(UPDATE|DELETE)/.test(c.sql) && c.params.includes(A)), "nenhuma escrita na linha da outra empresa");
  for (const c of consultas.filter((x) => /^\s*(UPDATE|DELETE)/.test(x.sql))) assert.match(c.sql, /empresa_id = \$2::uuid/);
});

test("código de categoria repetido na MESMA empresa é recusado; código inválido também", async () => {
  const tx: DbExecutor = { async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
    if (text.includes("AND codigo = $2")) return { rows: [{} as Row], rowCount: 1 };
    throw new Error(text);
  } };
  await assert.rejects(() => criarCategoriaBuffet(tx, A, "Salgados", true, "SALGADOS"), (e: unknown) => e instanceof PacoteAdminError && e.code === "CONFLITO");
  await assert.rejects(() => criarCategoriaBuffet(tx, A, "Salgados", true, "salgados; drop"), (e: unknown) => e instanceof PacoteAdminError && e.code === "DADOS_INVALIDOS");
});

test("exclusão de item e categoria da empresa, mas referenciados, falha fechada (pacotes, escolhas e adicionais)", async () => {
  const { tx, consultas } = banco(A, 2);
  await assert.rejects(
    () => excluirItemBuffet(tx, A, ITEM),
    (error: unknown) => error instanceof PacoteAdminError && error.message === "Este item está sendo usado por um ou mais pacotes e não pode ser excluído ainda.",
  );
  await assert.rejects(() => excluirCategoriaBuffet(tx, A, CATEGORIA), (error: unknown) => error instanceof PacoteAdminError && /não pode ser excluída ainda/.test(error.message));
  const usos = consultas.filter((c) => c.sql.includes("count(*)")).map((c) => c.sql).join("\n");
  assert.match(usos, /origem_buffet_item_id/);
  assert.match(usos, /origem_buffet_categoria_id/);
  assert.match(usos, /pacote_itens_especificos/);
  assert.ok(!consultas.some((c) => c.sql.startsWith("DELETE")));
});

test("item inativo nasce inativo; item sem uso da empresa é apagado", async () => {
  const { tx, consultas } = banco(A, 0);
  await criarItemBuffet(tx, A, "Taxa de rolha", null, false);
  const insercao = consultas.find((c) => c.sql.startsWith("INSERT INTO buffet_itens"))!;
  assert.deepEqual([insercao.params[0], insercao.params[1], insercao.params[4]], [A, null, false]);
  await excluirItemBuffet(tx, A, ITEM);
  const apagar = consultas.filter((c) => c.sql.startsWith("DELETE"));
  assert.equal(apagar.length, 1);
  assert.deepEqual(apagar[0].params, [ITEM, A]);
});
