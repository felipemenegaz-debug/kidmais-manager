import assert from "node:assert/strict";
import test from "node:test";
import { POLITICA_CANAIS, canalPermite } from "./canais.ts";

test("canal WhatsApp (preparado): só consulta e sugestão; confirmação só no Admin; nunca DENY nem disparo proativo", () => {
  assert.equal(canalPermite("WHATSAPP", "READ"), true);
  assert.equal(canalPermite("WHATSAPP", "SUGGEST"), true);
  assert.equal(canalPermite("WHATSAPP", "CONFIRM"), false);
  assert.equal(canalPermite("WHATSAPP", "DENY"), false);
  assert.equal(canalPermite("ADMIN", "DENY"), false);
  assert.equal(POLITICA_CANAIS.WHATSAPP.confirmacao, "SOMENTE_NO_ADMIN");
  assert.equal(Object.values(POLITICA_CANAIS).some((p) => p.podeEnviarProativo), false);
});
