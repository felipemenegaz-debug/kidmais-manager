import assert from "node:assert/strict";
import test from "node:test";
import { regraPadraoPacote } from "./disponibilidade.ts";

test("Pocket permite sexta-feira somente das 11h às 15h", () => {
  assert.equal(regraPadraoPacote("pocket", "2026-09-18", "almoco"), "disponivel");
  assert.equal(regraPadraoPacote("pocket", "2026-09-18", "noite"), "indisponivel");
  assert.equal(regraPadraoPacote("pocket", "2026-09-19", "almoco"), "indisponivel");
});

test("Pizza Party permanece sob consulta", () => {
  assert.equal(regraPadraoPacote("pizza_party_scienza", "2026-09-18", "almoco"), "consulta");
});
