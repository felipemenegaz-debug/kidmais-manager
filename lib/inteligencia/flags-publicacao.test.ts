import assert from "node:assert/strict";
import test from "node:test";
import { capacidadeForaDaContratacaoAtiva } from "./flags.ts";

test("R-5: qualquer capacidade fora da contratação ligada é detectada; sem a chave-mestra nada abre", () => {
  const base = { INTELIGENCIA_ENABLED: "true" };
  assert.equal(capacidadeForaDaContratacaoAtiva(base), false);
  for (const flag of ["AI_READ_ENABLED", "AI_ADMIN_ACTIONS_ENABLED", "AI_CONTRACT_IMPORT_ENABLED", "AI_OPERACIONAL_ENABLED", "AI_DEMERZEL_ENABLED"]) {
    assert.equal(capacidadeForaDaContratacaoAtiva({ ...base, [flag]: "true" }), true, flag);
    assert.equal(capacidadeForaDaContratacaoAtiva({ [flag]: "true" }), false, `${flag} sem a chave-mestra`);
    assert.equal(capacidadeForaDaContratacaoAtiva({ ...base, [flag]: "1" }), false, `${flag} só liga com "true"`);
  }
});
