import test from "node:test";
import assert from "node:assert/strict";
import type { DbExecutor } from "../db/contracts.ts";
import { reimportacaoInstalada, substituirImportacaoCancelada, type ImportacaoLida } from "./repositorio-importacao.ts";

/** 064 no repositório: detecção pelo catálogo e UPDATE condicionado (sem banco). */
function banco(op: { instalada?: boolean; alterada?: boolean } = {}) {
  const sql: Array<{ text: string; values: readonly unknown[] }> = [];
  const db: DbExecutor = { async query<Row extends object>(text: string, values: readonly unknown[] = []) {
    sql.push({ text, values });
    let rows: object[] = [];
    if (text.includes("to_regprocedure")) rows = [{ ok: op.instalada ?? true }];
    else if (text.startsWith("UPDATE")) rows = op.alterada === false ? [] : [{ id: "imp" }];
    return { rows: rows as Row[], rowCount: rows.length };
  } };
  return { db, sql };
}
const importada: ImportacaoLida = { id: "imp", documentoId: "doc", extracaoId: "ext", status: "IMPORTADA", versao: 3, dados: {}, clienteId: "cli", resultado: { destino: "/x" }, criadoPor: "u" };

test("sem a 064 nada é escrito; detecção lida do catálogo a cada chamada", async () => {
  const b = banco({ instalada: false });
  assert.equal(await reimportacaoInstalada(b.db), false);
  assert.equal(await substituirImportacaoCancelada(b.db, "emp", importada, "op"), false);
  assert.ok(b.sql.every((q) => !q.text.startsWith("UPDATE")));
});

test("só IMPORTADA entra no UPDATE; EM_REVISAO e DESCARTADA nem consultam o banco", async () => {
  for (const status of ["EM_REVISAO", "DESCARTADA"] as const) {
    const b = banco();
    assert.equal(await substituirImportacaoCancelada(b.db, "emp", { ...importada, status, clienteId: null, resultado: null }, "op"), false);
    assert.equal(b.sql.length, 0);
  }
});

test("UPDATE condicionado: empresa, IMPORTADA, versão conferida e contrato cancelado; resultado vai para dados->substituicao", async () => {
  const b = banco();
  assert.equal(await substituirImportacaoCancelada(b.db, "emp", importada, "operador"), true);
  const u = b.sql.find((q) => q.text.startsWith("UPDATE"))!;
  assert.deepEqual(u.values, ["imp", "emp", 3, "operador"]);
  assert.match(u.text, /status = 'DESCARTADA', versao = \$3 \+ 1, cliente_id = NULL, resultado = NULL/);
  assert.match(u.text, /AND status = 'IMPORTADA' AND versao = \$3\s+AND kidmais064_contrato_cancelado\(id\)/);
  assert.match(u.text, /'substituicao'/);
  const corrida = banco({ alterada: false });
  assert.equal(await substituirImportacaoCancelada(corrida.db, "emp", importada, "operador"), false, "contrato ativo ou versão diferente: nada muda");
});
