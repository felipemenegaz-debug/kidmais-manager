import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validarVinculoComposicao } from "./composicao.ts";
import { erroConvidadosPizzaParty, limitesPizzaParty } from "./pacotes-v1.ts";
import { PacoteAdminError } from "./pacotes-admin.ts";

test("item incluso não vira adicional pago", () => {
  assert.throws(
    () => validarVinculoComposicao({ pacoteCodigo: "COMPLETA", adicionalCodigo: "PENNE", modalidade: "EXTRA", modalidadeAtual: "INCLUSO" }),
    (error: unknown) => error instanceof PacoteAdminError && error.code === "INCLUSO_NAO_PAGO",
  );
});

test("Completa não recebe salada premium inclusa e Premium não perde a sua", () => {
  assert.throws(
    () => validarVinculoComposicao({ pacoteCodigo: "COMPLETA", adicionalCodigo: "SALADA_PREMIUM", modalidade: "INCLUSO", modalidadeAtual: "EXTRA" }),
    (error: unknown) => error instanceof PacoteAdminError && error.code === "SALADA_COMPLETA",
  );
  assert.throws(
    () => validarVinculoComposicao({ pacoteCodigo: "PREMIUM", adicionalCodigo: "SALADA_PREMIUM", modalidade: "EXTRA", modalidadeAtual: "INCLUSO" }),
    (error: unknown) => error instanceof PacoteAdminError && error.code === "SALADA_PREMIUM",
  );
  const matriz = readFileSync("database/migrations/20260923_023_adicionais_por_pacote.sql", "utf8");
  assert.equal(/SALADA_PREMIUM' AND p\.codigo = 'COMPLETA' THEN 'INCLUSO'/.test(matriz), false);
});

test("Pizza usa o limite persistido e Compacta acima de 40 continua sob consulta", () => {
  assert.deepEqual(limitesPizzaParty(null), { minimo: 20, maximo: 100 });
  assert.equal(erroConvidadosPizzaParty("PIZZA_PARTY", 25, { minimo: 30, maximo: 80 }) === null, false);
  assert.equal(erroConvidadosPizzaParty("PIZZA_PARTY", 40, { minimo: 30, maximo: 80 }), null);
  const preco = readFileSync("lib/comercial/services/pricing.service.ts", "utf8");
  assert.match(preco, /pacote\.codigo === "COMPACTA"/);
  assert.match(preco, /PACOTE_SOB_CONSULTA/);
});
