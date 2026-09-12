import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const migration = readFileSync("database/migrations/20260912_017_pocket_sexta.sql", "utf8");
const precheck = readFileSync("database/checks/20260912_017_precheck.sql", "utf8");
const postcheck = readFileSync("database/checks/20260912_017_postcheck.sql", "utf8");
const rollback = readFileSync("database/rollback/20260912_017_pocket_sexta_down.sql", "utf8");

test("Migration 017 altera somente a configuração temporal Pocket sexta/TURNO_1", () => {
  assert.doesNotMatch(migration, /\b(?:CREATE|ALTER|DROP|TRUNCATE)\b/i);
  assert.match(migration, /codigo = 'POCKET'/);
  assert.match(migration, /codigo = 'TURNO_1'/);
  assert.match(migration, /vigencia_fim = DATE '2026-09-11'/);
  assert.match(migration, /DATE '2026-09-12', NULL, true/);
  assert.match(migration, /'DISPONIVEL'/);
  assert.match(migration, /existe vigência concorrente/);
});

test("precheck, postcheck e rollback são fail-closed e preservam a regra anterior", () => {
  assert.match(precheck, /INTO STRICT pocket_id/);
  assert.match(precheck, /regra anterior do Pocket sexta\/TURNO_1 diverge/);
  assert.match(postcheck, /regra histórica anterior inválida/);
  assert.match(postcheck, /vigências sobrepostas/);
  assert.match(rollback, /Rollback 017 recusado: existem Fechamentos Pocket/);
  assert.match(rollback, /DELETE FROM public\.regras_disponibilidade_pacote/);
  assert.match(rollback, /SET vigencia_fim = NULL/);
});
