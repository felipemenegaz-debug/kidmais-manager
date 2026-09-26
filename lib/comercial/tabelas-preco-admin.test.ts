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

const empresa = "11111111-1111-4111-8111-111111111111";
const tabela = "22222222-2222-4222-8222-222222222222";

function publicar(responder: (text: string) => { rows: object[]; rowCount: number }) {
  const chamadas: string[] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
      chamadas.push(text);
      return responder(text) as DbQueryResult<Row>;
    },
  };
  return { tx, chamadas };
}

function respostaValida(text: string, updateRowCount = 1) {
  if (text.includes("FOR UPDATE")) {
    return { rows: [{ id: tabela, publicada_em: null, ativa: false, vigencia_inicio: "2026-10-01", vigencia_fim: "2026-12-31" }], rowCount: 1 };
  }
  if (text.includes("AS n")) return { rows: [{ n: 1 }], rowCount: 1 };
  if (text.startsWith("UPDATE tabelas_preco")) return { rows: [], rowCount: updateRowCount };
  return { rows: [], rowCount: 0 };
}

test("publicar não recalcula fechamento nem ativa a tabela no fechamento público", async () => {
  const { tx, chamadas } = publicar(respostaValida);
  await publicarTabelaPrecoAdmin(tx, { empresaId: empresa, tabelaId: tabela });
  const update = chamadas.find((sql) => sql.startsWith("UPDATE tabelas_preco")) ?? "";
  assert.match(update, /ativa = false/);
  assert.match(update, /publicada_em IS NULL/);
  assert.equal(chamadas.some((sql) => sql.includes("fechamentos")), false);
});

test("publicação recusa tabela vazia, faixa inválida, sobreposição e vigência cruzada", async () => {
  const casos: Array<{ trecho: string; corpo: { rows: object[]; rowCount: number }; codigo: string }> = [
    { trecho: "AS n", corpo: { rows: [{ n: 0 }], rowCount: 1 }, codigo: "TABELA_VAZIA" },
    { trecho: "convidados_min < 1", corpo: { rows: [{ "?column?": 1 }], rowCount: 1 }, codigo: "FAIXA_INVALIDA" },
    { trecho: "int4range", corpo: { rows: [{ "?column?": 1 }], rowCount: 1 }, codigo: "FAIXA_SOBREPOSTA" },
    { trecho: "daterange", corpo: { rows: [{ "?column?": 1 }], rowCount: 1 }, codigo: "VIGENCIA_SOBREPOSTA" },
  ];
  for (const caso of casos) {
    const { tx, chamadas } = publicar((text) => text.includes(caso.trecho) ? caso.corpo : respostaValida(text));
    await assert.rejects(
      () => publicarTabelaPrecoAdmin(tx, { empresaId: empresa, tabelaId: tabela }),
      (error: unknown) => error instanceof PacoteAdminError && error.code === caso.codigo,
    );
    assert.equal(chamadas.some((sql) => sql.startsWith("UPDATE")), false, caso.codigo);
  }
});

test("publicação recusa pacote de outra empresa e publicação concorrente", async () => {
  const cruzada = publicar((text) => text.includes("IS DISTINCT FROM") && text.includes("pacotes")
    ? { rows: [{ "?column?": 1 }], rowCount: 1 }
    : respostaValida(text));
  await assert.rejects(
    () => publicarTabelaPrecoAdmin(cruzada.tx, { empresaId: empresa, tabelaId: tabela }),
    (error: unknown) => error instanceof PacoteAdminError && error.code === "EMPRESA_DIVERGENTE" && error.httpStatus === 403,
  );
  assert.equal(cruzada.chamadas.some((sql) => sql.startsWith("UPDATE")), false);

  const concorrente = publicar((text) => respostaValida(text, 0));
  await assert.rejects(
    () => publicarTabelaPrecoAdmin(concorrente.tx, { empresaId: empresa, tabelaId: tabela }),
    (error: unknown) => error instanceof PacoteAdminError && error.code === "CONFLITO",
  );
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
  const guarda = readFileSync("database/migrations/20260926_035_publicacao_tabela_invariantes.sql", "utf8");
  assert.match(guarda, /HG-4/);
  assert.match(guarda, /daterange/);
  assert.match(guarda, /Rollback possível/);
  assert.equal(/DELETE FROM|UPDATE precos_pacote SET|UPDATE tabelas_preco SET/.test(guarda), false);
});
