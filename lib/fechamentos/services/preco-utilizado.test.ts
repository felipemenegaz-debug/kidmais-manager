import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync("database/migrations/20260926_030_preco_utilizado.sql", "utf8");
const rollback = readFileSync("database/rollback/20260926_030_preco_utilizado_down.sql", "utf8");

test("preço utilizado trava só atributos de cálculo e preserva atualizado_em", () => {
  assert.match(migration, /NEW\.valor IS DISTINCT FROM OLD\.valor/);
  assert.match(migration, /NEW\.tipo_calculo IS DISTINCT FROM OLD\.tipo_calculo/);
  assert.match(migration, /NEW\.categoria_horario IS DISTINCT FROM OLD\.categoria_horario/);
  assert.match(migration, /fechamentos WHERE preco_pacote_id/);
  assert.match(migration, /fechamento_pacote_snapshots WHERE preco_pacote_id/);
  assert.match(migration, /fechamento_revisoes WHERE preco_pacote_id/);
  assert.match(migration, /fechamento_adicionais WHERE preco_adicional_id/);
  assert.match(migration, /fechamento_revisao_adicionais WHERE preco_adicional_id/);
  assert.equal(/NEW\.(ativo|observacoes|atualizado_em)/.test(migration), false);
  assert.equal(/UPDATE precos_pacote|UPDATE precos_adicional|UPDATE tabelas_preco/.test(migration), false);
  assert.match(migration, /RETURN NEW/);
});

test("rollback da proteção remove só o gatilho novo", () => {
  assert.match(rollback, /DROP TRIGGER IF EXISTS precos_pacote_calculo_utilizado_trg ON precos_pacote/);
  assert.match(rollback, /DROP TRIGGER IF EXISTS precos_adicional_calculo_utilizado_trg ON precos_adicional/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS kidmais_030_preco_utilizado/);
  assert.equal(/DROP TABLE|DELETE FROM|UPDATE /.test(rollback), false);
});
