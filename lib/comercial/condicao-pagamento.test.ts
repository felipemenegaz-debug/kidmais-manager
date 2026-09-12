import assert from "node:assert/strict";
import test from "node:test";
import { calcularCondicaoComercial, centavosComerciais, validarPretensaoPix } from "./condicao-pagamento.ts";
import { valorFinalContrato } from "../contratos/services/snapshot-core.ts";

for (const [forma, percentual, final] of [
  ["PIX_AVISTA", 10, 8361], ["PIX_PARCELADO", 3, 9011.30], ["CARTAO_CIELO", 0, 9290],
] as const) test(`${forma}: base 9290, desconto ${percentual}%, final ${final}`, () => {
  const r = calcularCondicaoComercial(9290, forma);
  assert.equal(r.valorFinalContrato, final);
  assert.equal(r.descontoFormaPagamentoPercentual, percentual);
  assert.equal(centavosComerciais(r.valorDescontoFormaPagamento, true) + centavosComerciais(final), 929000);
});
test("arredondamento comercial em centavos e limites", () => {
  assert.equal(calcularCondicaoComercial(0.50, "PIX_PARCELADO").valorFinalContrato, 0.49);
  assert.equal(calcularCondicaoComercial(0.10, "PIX_PARCELADO").valorFinalContrato, 0.10);
  assert.equal(calcularCondicaoComercial(9999999999.99, "PIX_PARCELADO").valorFinalContrato, 9699999999.99);
});
test("base aprovada precede tabela e recebe desconto apenas uma vez", () => {
  assert.equal(valorFinalContrato({ valorAprovado: 9290, valorTabela: 12000,
    condicaoPagamento: { schemaVersao: 1, forma: "PIX_PARCELADO", pretendida: null, aprovada: null, revisaoStatus: "APROVADA" } }), 9011.30);
});
test("sem documento novo, resolução contratual legada permanece intacta", () => {
  assert.equal(valorFinalContrato({ valorAprovado: 9290, valorTabela: 12000 }), 9290);
  assert.equal(valorFinalContrato({ valorAprovado: null, valorTabela: 9290 }), 9290);
});
test("proposta parcial e entrada zero são aceitas sem completar um plano", () => {
  assert.deepEqual(validarPretensaoPix({ valorParcela: "500.25" }), { entradaCentavos: null, parcelaCentavos: 50025, quantidadeParcelas: null });
  assert.deepEqual(validarPretensaoPix({ entrada: 0, quantidadeParcelas: 3 }), { entradaCentavos: 0, parcelaCentavos: null, quantidadeParcelas: 3 });
  assert.equal(validarPretensaoPix({}), null);
});
for (const value of [true, false, -1, NaN, Infinity, 0.001, 1.0000000001, 0.0100000001, 10000000000,
  "1.00000000000000001", "1.001", "1e2", "", "1,50"]) {
  test(`rejeita dinheiro inválido: ${String(value)}`, () => assert.throws(() => centavosComerciais(value)));
}
test("quantidade inválida, subcentavos na proposta e campos de aprovação são rejeitados", () => {
  assert.throws(() => validarPretensaoPix({ quantidadeParcelas: 1.5 }));
  assert.throws(() => validarPretensaoPix({ quantidadeParcelas: 0 }));
  assert.throws(() => validarPretensaoPix({ entrada: "0.001" }));
  assert.throws(() => validarPretensaoPix({ valorParcela: 1.0000000001 }));
  assert.throws(() => validarPretensaoPix({ aprovada: true } as never));
});
