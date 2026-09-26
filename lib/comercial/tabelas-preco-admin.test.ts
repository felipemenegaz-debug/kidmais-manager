import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DbExecutor, DbQueryResult } from "../db/contracts.ts";
import { PacoteAdminError } from "./pacotes-admin.ts";
import { publicarTabelaPrecoAdmin, simularPrecoPacote, simularTabelaPublicada } from "./tabelas-preco-admin.ts";

test("simulação distingue preço, vazio e sob consulta", () => {
  assert.deepEqual(simularPrecoPacote({ valor: "10.50", sobConsulta: false }), { tipo: "PRECO", centavos: 1050 });
  assert.deepEqual(simularPrecoPacote({ valor: "", sobConsulta: false }), { tipo: "AUSENTE" });
  assert.deepEqual(simularPrecoPacote({ valor: null, sobConsulta: false }), { tipo: "AUSENTE" });
  assert.deepEqual(simularPrecoPacote({ valor: "10.00", sobConsulta: true }), { tipo: "SOB_CONSULTA" });
  assert.throws(() => simularPrecoPacote({ valor: "0", sobConsulta: false }));
});

test("a simulação da empresa usa a tabela publicada na data da festa", async () => {
  const empresa = "11111111-1111-4111-8111-111111111111";
  const tx: DbExecutor = {
    async query<Row extends object>(text: string, values?: readonly unknown[]): Promise<DbQueryResult<Row>> {
      assert.match(text, /t\.empresa_id = \$1::uuid/);
      assert.match(text, /t\.publicada_em IS NOT NULL/);
      assert.match(text, /t\.vigencia_inicio <= \$2::date/);
      assert.equal(text.includes("fechamentos"), false);
      assert.equal(values?.[0], empresa);
      return { rows: [{ valor: "64.90" } as Row], rowCount: 1 };
    },
  };
  assert.deepEqual(await simularTabelaPublicada(tx, {
    empresaId: empresa,
    data: "2026-10-10",
    pacoteId: "22222222-2222-4222-8222-222222222222",
    convidados: 40,
    categoriaHorario: "PADRAO",
    sobConsulta: false,
  }), { tipo: "PRECO", centavos: 6490 });
  const vazio: DbExecutor = { async query() { return { rows: [], rowCount: 0 }; } };
  assert.deepEqual(await simularTabelaPublicada(vazio, {
    empresaId: empresa, data: "2026-10-10", pacoteId: "22222222-2222-4222-8222-222222222222", convidados: 40, categoriaHorario: "PADRAO", sobConsulta: false,
  }), { tipo: "AUSENTE" });
});

test("publicar não recalcula fechamento nem ativa a tabela no fechamento público", async () => {
  const chamadas: string[] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
      chamadas.push(text);
      if (text.startsWith("SELECT")) return { rows: [{ id: "tabela-1", publicada_em: null } as Row], rowCount: 1 };
      if (text.startsWith("UPDATE tabelas_preco")) {
        assert.match(text, /ativa = false/);
        assert.equal(text.includes("fechamentos"), false);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(text);
    },
  };
  await publicarTabelaPrecoAdmin(tx, { empresaId: "11111111-1111-4111-8111-111111111111", tabelaId: "22222222-2222-4222-8222-222222222222" });
  assert.equal(chamadas.some((sql) => sql.includes("fechamentos")), false);
});

test("tabela já publicada entra em conflito e o PDF não é exigido", async () => {
  const tx: DbExecutor = {
    async query<Row extends object>(): Promise<DbQueryResult<Row>> {
      return { rows: [{ id: "tabela-1", publicada_em: "2026-09-26" } as Row], rowCount: 1 };
    },
  };
  await assert.rejects(
    () => publicarTabelaPrecoAdmin(tx, { empresaId: "11111111-1111-4111-8111-111111111111", tabelaId: "22222222-2222-4222-8222-222222222222" }),
    (error: unknown) => error instanceof PacoteAdminError && error.httpStatus === 409,
  );
  const migration = readFileSync("database/migrations/20260926_033_tabela_preco_publicacao.sql", "utf8");
  assert.equal(/UPDATE fechamentos|documentos_publicos|TABELA_PACOTES/.test(migration), false);
});
