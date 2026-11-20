import assert from "node:assert/strict";
import test from "node:test";
import { carregarModulo } from "../../acessos/teste-carregador.ts";
const { valorParaGravar } = carregarModulo("lib/fechamentos/services/valor-para-gravar.ts", {}) as typeof import("./valor-para-gravar");

test("o cliente legado grava pelo servidor mesmo enviando valor mais alto ou mais baixo", () => {
  for (const proposto of [undefined, 1, 9999]) assert.equal(valorParaGravar("CLIENTE", 123.45, proposto), 123.45);
});

test("mudança para qualquer lado retorna 409 com o preço atual até nova confirmação", () => {
  for (const exibido of [12344, 12346]) {
    assert.throws(() => valorParaGravar("CLIENTE", 123.45, 1, exibido),
      { code: "PRECO_MUDOU", httpStatus: 409, details: { totalCentavos: 12345 } });
  }
  assert.equal(valorParaGravar("CLIENTE", 123.45, 1, 12345), 123.45);
});
