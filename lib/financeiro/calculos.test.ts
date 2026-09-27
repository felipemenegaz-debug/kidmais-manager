import test from "node:test";
import assert from "node:assert/strict";
import {
  aceitaBaixa,
  centavosDe,
  escolherParcelaAberta,
  liquidoCentavos,
  margemEstimada,
  periodoSelecionado,
  resultadoCaixa,
  statusPagar,
  statusReceber,
  vencimentosMensais,
} from "./calculos.ts";

test("vencido é derivado e a taxa reduz só o líquido", () => {
  assert.equal(statusReceber({
    cancelado: false, reembolsado: false, valorCentavos: 10000, recebidoCentavos: 0, vencimento: "2026-03-01", hoje: "2026-03-17",
  }), "Vencido");
  assert.equal(statusReceber({
    cancelado: false, reembolsado: false, valorCentavos: 10000, recebidoCentavos: 4000, vencimento: "2026-03-20", hoje: "2026-03-17",
  }), "Parcialmente pago");
  assert.equal(statusReceber({
    cancelado: false, reembolsado: false, valorCentavos: 10000, recebidoCentavos: 10000, vencimento: "2026-03-01", hoje: "2026-03-17",
  }), "Pago");
  assert.equal(statusPagar({
    cancelado: false, valorCentavos: 5000, pagoCentavos: 0, vencimento: "2026-03-01", hoje: "2026-03-17",
  }), "Vencido");
  assert.equal(liquidoCentavos(10000, 350), 9650);
  assert.equal(aceitaBaixa(6000, 6000), true);
  assert.equal(aceitaBaixa(6000, 6001), false);
  assert.equal(margemEstimada(90000, 25000), 65000);
  assert.equal(centavosDe("47300.00"), 4730000);
});

test("recorrência mensal cabe no mês e não é infinita", () => {
  const datas = vencimentosMensais("2026-01-31", 3);
  assert.deepEqual(datas, ["2026-01-31", "2026-02-28", "2026-03-31"]);
});

test("período e parcela aberta usam a mesma regra na interface", () => {
  assert.deepEqual(periodoSelecionado("2026-03-18", "mes"), { inicio: "2026-03-01", fim: "2026-03-31" });
  assert.deepEqual(periodoSelecionado("2026-03-18", "anterior"), { inicio: "2026-02-01", fim: "2026-02-28" });
  assert.deepEqual(periodoSelecionado("2026-03-18", "30"), { inicio: "2026-02-17", fim: "2026-03-18" });
  assert.equal(resultadoCaixa(4000, 1000), 3000);
  const abertas = [
    { id: "a", status: "A receber" },
    { id: "b", status: "Vencido" },
    { id: "c", status: "Cancelado" },
    { id: "d", status: "Pago" },
  ];
  assert.equal(escolherParcelaAberta(abertas).ambiguo, true);
  assert.equal(escolherParcelaAberta(abertas).parcela, null);
  assert.equal(escolherParcelaAberta(abertas, "b").parcela?.id, "b");
  assert.equal(escolherParcelaAberta([{ id: "a", status: "A receber" }]).parcela?.id, "a");
  assert.equal(escolherParcelaAberta([{ id: "c", status: "Cancelado" }]).vazia, true);
});
