import assert from "node:assert/strict";
import test from "node:test";
import { exigirOptInDescartavel, PORTA_PADRAO, portaDescartavel } from "./alvo-descartavel.ts";

/**
 * Guarda do cluster descartável (módulo puro, sem driver): sem opt-in, porta explícita e autorização literal, nenhuma
 * suíte conecta; nada genérico escolhe o destino. Testes estáticos não citam a porta nem o conector do descartável.
 */
const OPT_IN = { KIDMAIS_POSTGRES_DESCARTAVEL: "kidmais_pacotes_v1_descartavel" };

test("sem opt-in explícito nenhuma porta é resolvida (execução local comum não conecta)", () => {
  assert.throws(() => exigirOptInDescartavel({}), /sem opt-in explícito/);
  assert.throws(() => portaDescartavel({}), /sem opt-in explícito/);
  // Variáveis herdadas (homologação, DATABASE_URL, PG*) não substituem o opt-in.
  assert.throws(() => portaDescartavel({ KIDMAIS_HOMOLOGACAO_DATABASE_URL: "postgresql://x@127.0.0.1:1/y", DATABASE_URL: "postgresql://x@10.0.0.1:5432/kidmais_manager", PGPORT: "5432" }), /sem opt-in explícito/);
  assert.throws(() => portaDescartavel({ KIDMAIS_POSTGRES_DESCARTAVEL: "kidmais_manager" }), /sem opt-in explícito/);
});

test("com opt-in, porta e autorização literal são obrigatórias (sem porta padrão)", () => {
  assert.ok(Number.isInteger(PORTA_PADRAO) && PORTA_PADRAO > 1024);
  assert.throws(() => portaDescartavel(OPT_IN), /não usa porta padrão/);
  const ok = { ...OPT_IN, KIDMAIS_DESCARTAVEL_PORTA: "55499", KIDMAIS_DESCARTAVEL_AUTORIZACAO: "127.0.0.1:55499/kidmais_pacotes_v1_descartavel" };
  assert.equal(portaDescartavel(ok), 55499);
  for (const env of [
    { ...OPT_IN, KIDMAIS_DESCARTAVEL_PORTA: "55499" },
    { ...ok, KIDMAIS_DESCARTAVEL_AUTORIZACAO: `127.0.0.1:${PORTA_PADRAO}/kidmais_pacotes_v1_descartavel` },
    { ...ok, KIDMAIS_DESCARTAVEL_AUTORIZACAO: "127.0.0.1:55499/kidmais_manager" },
    { ...ok, KIDMAIS_DESCARTAVEL_AUTORIZACAO: "10.0.0.1:55499/kidmais_pacotes_v1_descartavel" },
    { ...ok, KIDMAIS_DESCARTAVEL_PORTA: "5432x" },
    { ...ok, KIDMAIS_DESCARTAVEL_PORTA: "80" },
  ]) assert.throws(() => portaDescartavel(env), JSON.stringify(env));
});
