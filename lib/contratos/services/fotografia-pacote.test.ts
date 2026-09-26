import test from "node:test";
import assert from "node:assert/strict";
import type { DbExecutor, DbQueryResult } from "../../db/contracts.ts";
import { lerFotografiaPacoteVigente } from "./fotografia-pacote.ts";

function executor(respostas: Array<{ texto: string; rows: object[]; rowCount?: number }>): DbExecutor & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
      sql.push(text);
      const resposta = respostas.find((item) => text.includes(item.texto));
      if (!resposta) throw new Error(text);
      return { rows: resposta.rows as Row[], rowCount: resposta.rowCount ?? resposta.rows.length };
    },
  };
}

test("sem a tabela de fotografia o contrato permanece no schema antigo", async () => {
  const tx = executor([{ texto: "to_regclass", rows: [{ rel: null }] }]);
  assert.equal(await lerFotografiaPacoteVigente(tx, "fechamento-1"), null);
  assert.equal(tx.sql.some((item) => item.includes("JOIN pacotes")), false);
});

test("fotografia vigente não consulta o cadastro vivo de pacote", async () => {
  const tx = executor([
    { texto: "to_regclass", rows: [{ rel: "fechamento_pacote_snapshots" }] },
    {
      texto: "FROM fechamentos f",
      rows: [{
        id: "snap-1",
        pacote_id: "pacote-1",
        codigo_aplicado: "COMPLETA",
        nome_aplicado: "Nome aplicado",
        descricao_aplicada: null,
        duracao_minutos_aplicada: null,
        tabela_preco_id: "tabela-1",
        tabela_codigo_aplicado: "TABELA_A",
        tabela_nome_aplicado: "Tabela A",
      }],
    },
    {
      texto: "fechamento_pacote_composicao",
      rows: [{ tipo: "INCLUSO", codigo_aplicado: "PENNE", nome_aplicado: "Penne", modo_itens: null, escolhas_min: null, escolhas_max: null }],
    },
  ]);
  const aplicada = await lerFotografiaPacoteVigente(tx, "fechamento-1");
  assert.equal(aplicada?.nome, "Nome aplicado");
  assert.equal(aplicada?.duracaoMinutos, null);
  assert.equal(aplicada?.tabelaPreco.codigo, "TABELA_A");
  assert.deepEqual(aplicada?.composicao.map((item) => item.codigo), ["PENNE"]);
  assert.equal(tx.sql.some((item) => item.includes("JOIN pacotes") || item.includes("JOIN tabelas_preco")), false);
});

test("fechamento legado com tabela presente e sem ponteiro não inventa composição", async () => {
  const tx = executor([
    { texto: "to_regclass", rows: [{ rel: "fechamento_pacote_snapshots" }] },
    { texto: "FROM fechamentos f", rows: [] },
  ]);
  assert.equal(await lerFotografiaPacoteVigente(tx, "fechamento-antigo"), null);
  assert.equal(tx.sql.some((item) => item.includes("fechamento_pacote_composicao")), false);
});
