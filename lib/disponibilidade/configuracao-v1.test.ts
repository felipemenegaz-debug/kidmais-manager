import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("candidata V1 não contém exceções comerciais pré-carregadas", () => {
  const configuracao = JSON.parse(
    readFileSync(
      new URL("../../data/disponibilidade.json", import.meta.url),
      "utf8",
    ),
  ) as {
    pacoteOverrides?: unknown[];
    descontos?: unknown[];
  };

  assert.deepEqual(configuracao.pacoteOverrides, []);
  assert.deepEqual(configuracao.descontos, []);
});
