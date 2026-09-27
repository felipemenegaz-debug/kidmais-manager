import test from "node:test";
import assert from "node:assert/strict";
import { centavosDe } from "./calculos.ts";
import { centavosDaTaxaGravada, chaveNoTenant, mesmaBaixa, type BaixaGravada } from "./idempotencia.ts";

const gravada: BaixaGravada = {
  brutoCentavos: 10000,
  meio: "PIX",
  forma: "PIX",
  taxaCentavos: 100,
  parcelaId: "parcela-100",
  alocadoCentavos: 10000,
  data: "2026-09-01",
  observacao: "entrada",
  alocacoes: 1,
};

const pedido = {
  parcelaId: "parcela-100",
  valor: 100,
  data: "2026-09-01",
  forma: "PIX" as const,
  taxa: 1,
  observacao: "entrada",
  chave: "chave-100",
};

test("taxa gravada em centavos não é convertida de novo", () => {
  assert.equal(centavosDaTaxaGravada(100), 100);
  assert.equal(centavosDe(1), 100);
  assert.equal(centavosDaTaxaGravada(100), centavosDe(1));
  assert.equal(mesmaBaixa(gravada, pedido), true);
});

test("a mesma chave no mesmo tenant exige o payload inteiro", () => {
  assert.equal(mesmaBaixa(gravada, { ...pedido, data: "2026-09-02" }), false);
  assert.equal(mesmaBaixa(gravada, { ...pedido, observacao: " entrada " }), true);
  assert.equal(mesmaBaixa(gravada, { ...pedido, observacao: "outra" }), false);
  assert.equal(mesmaBaixa(gravada, { ...pedido, taxa: 2 }), false);
  assert.equal(mesmaBaixa(gravada, { ...pedido, valor: 40 }), false);
  assert.equal(mesmaBaixa(gravada, { ...pedido, parcelaId: "outra" }), false);
  assert.equal(mesmaBaixa(gravada, { ...pedido, forma: "DINHEIRO" }), false);
});

test("a mesma chave em empresas diferentes não é a mesma operação", () => {
  const chave = "chave-compartilhada";
  assert.equal(chaveNoTenant("empresa-a", "recebimento", chave), chaveNoTenant("empresa-a", "recebimento", chave));
  assert.notEqual(chaveNoTenant("empresa-a", "recebimento", chave), chaveNoTenant("empresa-b", "recebimento", chave));
  assert.notEqual(chaveNoTenant("empresa-a", "recebimento", chave), chaveNoTenant("empresa-a", "pagamento", chave));
});
