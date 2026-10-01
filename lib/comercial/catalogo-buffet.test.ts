import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { criarCategoriaBuffet, criarItemBuffet, excluirCategoriaBuffet, excluirItemBuffet } from "./catalogo-buffet.ts";
import { PacoteAdminError } from "./pacotes-admin.ts";
import type { DbExecutor, DbQueryResult } from "../db/contracts.ts";

test("o down 050 trava antes de checar e antes de apagar", () => {
  const sql = readFileSync("database/rollback/20260927_050_item_sem_categoria_down.sql", "utf8");
  const trava = sql.indexOf("kidmais-050-down");
  const checagem = sql.indexOf("categoria_id IS NULL");
  const queda = sql.indexOf("DROP TABLE");
  assert.equal(trava >= 0 && trava < checagem && checagem < queda, true);
  assert.equal(sql.indexOf("LOCK TABLE public.buffet_itens") < checagem, true);
  assert.equal(sql.includes("LOCK TABLE public.pacote_itens_especificos"), true);
});

test("exclusão de item e categoria referenciados falha fechada", async () => {
  const item: DbExecutor = { async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
    if (text.includes("to_regclass")) return { rows: [{ ok: false } as Row], rowCount: 1 };
    if (text.includes("count(*)")) return { rows: [{ n: 2 } as Row], rowCount: 1 };
    throw new Error(text);
  } };
  await assert.rejects(
    () => excluirItemBuffet(item, "11111111-1111-4111-8111-111111111111"),
    (error: unknown) => error instanceof PacoteAdminError && error.message === "Este item está sendo usado por um ou mais pacotes e não pode ser excluído ainda.",
  );

  const categoria: DbExecutor = { async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
    if (text.includes("count(*)")) return { rows: [{ n: 1 } as Row], rowCount: 1 };
    throw new Error(text);
  } };
  await assert.rejects(
    () => excluirCategoriaBuffet(categoria, "22222222-2222-4222-8222-222222222222"),
    (error: unknown) => error instanceof PacoteAdminError && /não pode ser excluída ainda/.test(error.message),
  );
});

test("item inativo nasce inativo e a categoria em todos os ativos segura o item", async () => {
  const gravados: unknown[][] = [];
  const consultas: string[] = [];
  const tx: DbExecutor = { async query<Row extends object>(text: string, values?: readonly unknown[]): Promise<DbQueryResult<Row>> {
    consultas.push(text);
    if (text.startsWith("INSERT INTO buffet_itens")) {
      gravados.push([...(values ?? [])]);
      return { rows: [{ id: "11111111-1111-4111-8111-111111111111" } as Row], rowCount: 1 };
    }
    if (text.startsWith("INSERT INTO buffet_categorias")) {
      gravados.push([...(values ?? [])]);
      return { rows: [{ id: "22222222-2222-4222-8222-222222222222" } as Row], rowCount: 1 };
    }
    if (text.includes("count(*)")) return { rows: [{ n: 1 } as Row], rowCount: 1 };
    if (text.includes("to_regclass")) return { rows: [{ ok: false } as Row], rowCount: 1 };
    throw new Error(text);
  } };
  await criarCategoriaBuffet(tx, "Bolo", false);
  await criarItemBuffet(tx, "Taxa de rolha", null, false);
  assert.equal(gravados[0]?.[2], false);
  assert.equal(gravados[1]?.[3], false);
  await assert.rejects(
    () => excluirItemBuffet(tx, "11111111-1111-4111-8111-111111111111"),
    (error: unknown) => error instanceof PacoteAdminError && error.message === "Este item está sendo usado por um ou mais pacotes e não pode ser excluído ainda.",
  );
  const uso = consultas.find((sql) => sql.includes("TODOS_ATIVOS")) ?? "";
  assert.equal(uso.includes("p.ativo"), false);
  assert.equal(uso.includes("arquivado_em"), false);
});

test("item sem uso é apagado", async () => {
  const apagados: string[] = [];
  const tx: DbExecutor = { async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
    if (text.includes("to_regclass")) return { rows: [{ ok: true } as Row], rowCount: 1 };
    if (text.includes("count(*)")) return { rows: [{ n: 0 } as Row], rowCount: 1 };
    if (text.startsWith("DELETE")) {
      apagados.push(text);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(text);
  } };
  await excluirItemBuffet(tx, "11111111-1111-4111-8111-111111111111");
  assert.equal(apagados.length, 1);
});
