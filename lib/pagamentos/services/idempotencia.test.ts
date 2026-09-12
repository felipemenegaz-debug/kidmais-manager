import assert from "node:assert/strict";
import test from "node:test";
import type { EstornoRecord, RecebimentoAlocacaoRecord, RecebimentoRecord } from "../repositories";
import { validarRepeticaoEstorno, validarRepeticaoRecebimento } from "./idempotencia.ts";

const recebimento = { pagamentoId: "pagamento-a", meioPagamento: "PIX", valorBruto: 100 } as RecebimentoRecord;
const alocacoes = [
  { parcelaId: "parcela-a", valorAlocado: 40 },
  { parcelaId: "parcela-b", valorAlocado: 60 },
] as RecebimentoAlocacaoRecord[];
const input = {
  pagamentoId: "pagamento-a", meioPagamento: "PIX" as const, valorBruto: 100,
  alocacoes: [{ parcelaId: "parcela-b", valor: 60 }, { parcelaId: "parcela-a", valor: 40 }],
};
const conflito = { httpStatus: 409 };

test("repetição de recebimento aceita as mesmas alocações em outra ordem", () => {
  assert.doesNotThrow(() => validarRepeticaoRecebimento(recebimento, alocacoes, input));
});

test("repetição de recebimento rejeita mudança de pagamento, meio, valor ou alocação", () => {
  for (const alteracao of [
    { pagamentoId: "outro" }, { meioPagamento: "DINHEIRO" as const }, { valorBruto: 101 },
    { alocacoes: [{ parcelaId: "parcela-a", valor: 100 }] },
    { alocacoes: [{ parcelaId: "parcela-a", valor: 40 }, { parcelaId: "parcela-a", valor: 60 }] },
    { alocacoes: [{ parcelaId: "parcela-a", valor: 60 }, { parcelaId: "parcela-b", valor: 40 }] },
  ]) assert.throws(() => validarRepeticaoRecebimento(recebimento, alocacoes, { ...input, ...alteracao }), conflito);
});

const estorno = { recebimentoId: "recebimento-a", parcelaId: "parcela-a", valor: 40 } as EstornoRecord;
const inputEstorno = { ...estorno, pagamentoId: "pagamento-a" };

test("identificadores equivalentes em maiúsculas preservam idempotência", () => {
  assert.doesNotThrow(() => validarRepeticaoRecebimento(recebimento, alocacoes, {
    ...input, pagamentoId: input.pagamentoId.toUpperCase(),
    alocacoes: input.alocacoes.map(a => ({ ...a, parcelaId: a.parcelaId.toUpperCase() })),
  }));
  assert.doesNotThrow(() => validarRepeticaoEstorno(estorno, "pagamento-a", {
    ...inputEstorno, pagamentoId: "PAGAMENTO-A", recebimentoId: "RECEBIMENTO-A", parcelaId: "PARCELA-A",
  }));
});

test("repetição de estorno exige o mesmo pagamento de origem", () => {
  assert.doesNotThrow(() => validarRepeticaoEstorno(estorno, "pagamento-a", inputEstorno));
  assert.throws(() => validarRepeticaoEstorno(estorno, "pagamento-b", inputEstorno), conflito);
});

test("repetição de estorno rejeita recebimento, parcela ou valor diferentes", () => {
  for (const alteracao of [{ recebimentoId: "outro" }, { parcelaId: "outra" }, { valor: 41 }]) {
    assert.throws(() => validarRepeticaoEstorno(estorno, "pagamento-a", { ...inputEstorno, ...alteracao }), conflito);
  }
});
