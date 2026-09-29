import assert from "node:assert/strict";
import test from "node:test";
import { PORTA_PADRAO, portaDescartavel } from "./alvo-descartavel.ts";

/**
 * Guarda do cluster descartável (módulo puro, sem driver): outra porta só com autorização literal;
 * nada genérico escolhe o destino. Testes estáticos não citam a porta nem o conector do descartável.
 */
test("porta padrão sem variáveis; outra porta exige autorização literal host:porta/banco", () => {
  assert.ok(Number.isInteger(PORTA_PADRAO) && PORTA_PADRAO > 1024);
  assert.equal(portaDescartavel({}), PORTA_PADRAO);
  assert.equal(portaDescartavel({ DATABASE_URL: "postgresql://x@10.0.0.1:5432/kidmais_manager", PGPORT: "5432" }), PORTA_PADRAO, "variáveis genéricas não mudam o destino");
  const ok = { KIDMAIS_DESCARTAVEL_PORTA: "55499", KIDMAIS_DESCARTAVEL_AUTORIZACAO: "127.0.0.1:55499/kidmais_pacotes_v1_descartavel" };
  assert.equal(portaDescartavel(ok), 55499);
  for (const env of [
    { KIDMAIS_DESCARTAVEL_PORTA: "55499" },
    { ...ok, KIDMAIS_DESCARTAVEL_AUTORIZACAO: `127.0.0.1:${PORTA_PADRAO}/kidmais_pacotes_v1_descartavel` },
    { ...ok, KIDMAIS_DESCARTAVEL_AUTORIZACAO: "127.0.0.1:55499/kidmais_manager" },
    { ...ok, KIDMAIS_DESCARTAVEL_AUTORIZACAO: "10.0.0.1:55499/kidmais_pacotes_v1_descartavel" },
    { ...ok, KIDMAIS_DESCARTAVEL_PORTA: "5432x" },
    { ...ok, KIDMAIS_DESCARTAVEL_PORTA: "80" },
  ]) assert.throws(() => portaDescartavel(env), JSON.stringify(env));
});
