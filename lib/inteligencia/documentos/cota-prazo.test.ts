import assert from "node:assert/strict";
import test from "node:test";
import { PRAZO_RESERVA_MINUTOS } from "../../importacao-contrato/cota.ts";
import { FOLGA_PRAZO_MS } from "../../importacao-contrato/pdf-isolado.ts";
import { LIMITES } from "../../importacao-contrato/pdf-texto.ts";
import { politicaDoAmbiente } from "../modelos/roteador.ts";

/** L2: o prazo da reserva (15 min) contra o pior caso nominal da leitura. Fica na camada de IA porque lê o roteador. */

test("prazo da reserva cobre com folga o pior caso nominal de uma leitura (parser + 3 tentativas no teto absoluto do roteador)", () => {
  // Política no máximo configurável: AI_MODEL_TIMEOUT_MS até 120 s e até 2 tentativas extras (roteador.ts:91–92);
  // acima disso a política volta ao padrão, então o pior caso é o próprio máximo.
  const politica = politicaDoAmbiente({ AI_MODEL_TIMEOUT_MS: "120000", AI_MODEL_MAX_RETRIES: "2" });
  assert.equal(politicaDoAmbiente({ AI_MODEL_TIMEOUT_MS: "999999999", AI_MODEL_MAX_RETRIES: "99" }).timeoutMs <= 120_000, true);
  assert.equal(politica.timeoutMs, 120_000);
  assert.equal(politica.tentativasExtras, 2);
  // Teto absoluto por tentativa quando a chamada pede prazo próprio (roteador.ts:270): 180 s.
  const porTentativa = Math.max(politica.timeoutMs, 180_000);
  const parser = LIMITES.prazoPadraoMs + FOLGA_PRAZO_MS;
  // Banco e persistência (reserva, conclusão e gravação da extração): 2 minutos de folga declarada, não medida.
  const banco = 120_000;
  const pior = parser + (politica.tentativasExtras + 1) * porTentativa + banco;
  assert.equal(pior, 665_000);
  assert.ok(pior < PRAZO_RESERVA_MINUTOS * 60_000, `pior caso nominal ${pior} ms ≥ prazo ${PRAZO_RESERVA_MINUTOS} min`);
});
