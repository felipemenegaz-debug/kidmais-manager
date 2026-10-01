import assert from "node:assert/strict";
import test from "node:test";
import { faixasContiguas, normalizarValorInformado, validarFaixas, type ModeloPreco } from "./modelo-preco.ts";

const limites = { minimo: 20, maximo: 50 };

test("faixas fixas aceitam o intervalo do pacote e recusam sobreposição", () => {
  const faixas = validarFaixas([
    { convidadosMin: 31, convidadosMax: 40, valor: "7.390,00" },
    { convidadosMin: 20, convidadosMax: 30, valor: "6490.00" },
    { convidadosMin: 41, convidadosMax: 50, valor: "8190" },
  ], limites);
  assert.deepEqual(faixas.map((faixa) => faixa.convidadosMin), [20, 31, 41]);
  assert.equal(faixas[0]?.valor, "6490.00");
  assert.equal(faixasContiguas(faixas, limites), true);
  assert.throws(() => validarFaixas([
    { convidadosMin: 20, convidadosMax: 35, valor: "10.00" },
    { convidadosMin: 30, convidadosMax: 40, valor: "20.00" },
  ], limites), /sobrepor/);
  assert.throws(() => validarFaixas([{ convidadosMin: 10, convidadosMax: 20, valor: "10.00" }], limites), /mínimo e o máximo/);
});

test("o domínio distingue faixa, base com excedente e preço por convidado", () => {
  const modelos: ModeloPreco[] = [
    { tipo: "POR_FAIXA", faixas: [{ convidadosMin: 20, convidadosMax: 30, valor: "6490.00" }] },
    { tipo: "BASE_EXCEDENTE", ate: 30, valorBase: "6490.00", valorAdicional: "180.00" },
    { tipo: "POR_CONVIDADO", valor: "180.00", minimoFaturavel: 20 },
  ];
  assert.deepEqual(modelos.map((modelo) => modelo.tipo), ["POR_FAIXA", "BASE_EXCEDENTE", "POR_CONVIDADO"]);
  assert.equal(normalizarValorInformado("R$ 6.490,00"), "6490.00");
});
