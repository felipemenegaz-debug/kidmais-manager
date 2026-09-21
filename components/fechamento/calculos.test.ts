import assert from "node:assert/strict";
import test from "node:test";
import { PACOTES } from "./data.ts";
import { precoReferenciaPacote } from "./calculos.ts";

test("Pocket usa R$ 190 por convidado e mínimo faturável de 20", () => {
  assert.equal(precoReferenciaPacote("pocket", 19), 3800);
  assert.equal(precoReferenciaPacote("pocket", 20), 3800);
  assert.equal(precoReferenciaPacote("pocket", 21), 3990);

  const pocket = PACOTES.find((pacote) => pacote.id === "pocket");
  assert.ok(pocket);
  assert.match(pocket.observacao ?? "", /R\$ 190 por convidado/);
  assert.doesNotMatch(pocket.observacao ?? "", /por criança/i);
});

test("Compacta só calcula automaticamente a condição persistida de 40 convidados", () => {
  assert.equal(precoReferenciaPacote("compacta", 40), 6490);
  assert.equal(precoReferenciaPacote("compacta", 39), null);
  assert.equal(precoReferenciaPacote("compacta", 41), null);
});

test("Pizza Party permanece sem preço automático", () => {
  assert.equal(precoReferenciaPacote("pizza_party_scienza", 20), null);
  const pizza = PACOTES.find((pacote) => pacote.id === "pizza_party_scienza");
  assert.ok(pizza);
  assert.equal(pizza.precoInicial, null);
  assert.equal(pizza.sobConsulta, true);
});
