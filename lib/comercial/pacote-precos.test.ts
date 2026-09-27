import assert from "node:assert/strict";
import test from "node:test";
import type { DbExecutor, DbQueryResult } from "../db/contracts.ts";
import { gravarFaixasPacote } from "./pacote-precos.ts";

const empresa = "11111111-1111-4111-8111-111111111111";
const pacote = "22222222-2222-4222-8222-222222222222";
const ctx = { empresaId: empresa, usuarioId: "usuario-1", requestId: "req-1", motivo: "PACOTE_EDITADO" };
const faixa = { convidadosMin: 20, convidadosMax: 30, valor: "6490.00" };

function executor(sqls: string[], publicada: boolean): DbExecutor {
  return { async query<Row extends object>(text: string, values?: readonly unknown[]): Promise<DbQueryResult<Row>> {
    sqls.push(text);
    if (text.includes("ORDER BY criado_em DESC") && text.includes("LIMIT 1") && !text.includes("FOR UPDATE")) return { rows: [], rowCount: 0 };
    if (text.includes("publicada_em IS NOT NULL") && text.includes("vigencia_inicio")) {
      return { rows: (publicada ? [{ id: "tabela-publicada" }] : []) as Row[], rowCount: publicada ? 1 : 0 };
    }
    if (text.includes("FOR UPDATE")) {
      assert.equal(text.includes("publicada_em IS NULL"), true);
      return { rows: [{ id: "tabela-aberta", publicada_em: null } as Row], rowCount: 1 };
    }
    if (text.includes("preco_pacote_id")) return { rows: [], rowCount: 0 };
    if (text.startsWith("DELETE") || text.startsWith("INSERT INTO precos_pacote") || text.startsWith("INSERT INTO tabela_preco_escopo")) {
      assert.equal(values?.[0] === "tabela-publicada", false);
      if (text.startsWith("INSERT INTO tabela_preco_escopos")) return { rows: [{ id: "escopo-1" } as Row], rowCount: 1 };
    }
    if (text.includes("UPDATE precos_pacote") || text.includes("UPDATE fechamento") || text.includes("UPDATE tabelas_preco")) {
      throw new Error(`escrita proibida: ${text}`);
    }
    return { rows: [], rowCount: 1 };
  } };
}

test("faixa nova entra só na tabela ainda não publicada e não altera preço histórico", async () => {
  const sqls: string[] = [];
  const resultado = await gravarFaixasPacote(executor(sqls, false), empresa, pacote, [faixa], { minimo: 20, maximo: 30 }, ctx);
  assert.equal(resultado.aplicado, true);
  assert.equal(resultado.aviso, null);
  assert.equal(sqls.some((sql) => sql.startsWith("INSERT INTO precos_pacote")), true);
  assert.equal(sqls.some((sql) => sql.includes("UPDATE precos_pacote") || sql.includes("fechamento_pacote_snapshots") && sql.startsWith("UPDATE")), false);
});

test("tabela publicada que cobre hoje impede trocar o preço", async () => {
  const sqls: string[] = [];
  const resultado = await gravarFaixasPacote(executor(sqls, true), empresa, pacote, [faixa], { minimo: 20, maximo: 30 }, ctx);
  assert.equal(resultado.aplicado, false);
  assert.match(resultado.aviso ?? "", /protegidos/);
  assert.equal(sqls.some((sql) => sql.startsWith("INSERT INTO precos_pacote") || sql.startsWith("UPDATE")), false);
});
