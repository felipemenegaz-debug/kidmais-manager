import assert from "node:assert/strict";
import test from "node:test";
import { classificarDocumentoIdentidade, documentoDoSnapshot, mesmoDocumento, pareceCpf } from "./documento.ts";

// Entrega B (R2-1): a entrada pública "CPF ou CNPJ" é classificada pelo formato; o que não fecha DV é recusado.
test("classificação: CPF com DV, CNPJ numérico e alfanumérico; DV errado, raiz repetida e lixo → null", () => {
  assert.deepEqual(classificarDocumentoIdentidade("529.982.247-25"), { tipo: "CPF", valor: "52998224725" });
  assert.deepEqual(classificarDocumentoIdentidade(" 11.222.333/0001-81 "), { tipo: "CNPJ", valor: "11222333000181" });
  assert.deepEqual(classificarDocumentoIdentidade("12.abc.345/01de-35"), { tipo: "CNPJ", valor: "12ABC34501DE35" });
  for (const ruim of ["52998224726", "11111111111", "11222333000182", "11111111111180", "AAAAAAAAAAAA00", "abc", "", "5299822472"]) {
    assert.equal(classificarDocumentoIdentidade(ruim), null, ruim);
  }
  assert.equal(pareceCpf("529.982.247"), true);
  assert.equal(pareceCpf("11.222.333/0001"), false);
});

test("documento do snapshot: PF (sem tipo) = CPF; PJ = CNPJ; comparação exige tipo e valor iguais", () => {
  const pf = documentoDoSnapshot({ cpf: "52998224725" });
  const pj = documentoDoSnapshot({ tipoPessoa: "PJ", cpf: "", cnpj: "12ABC34501DE35" });
  assert.deepEqual(pf, { tipo: "CPF", valor: "52998224725" });
  assert.deepEqual(pj, { tipo: "CNPJ", valor: "12ABC34501DE35" });
  assert.equal(mesmoDocumento(classificarDocumentoIdentidade("12.ABC.345/01DE-35"), pj), true);
  assert.equal(mesmoDocumento(classificarDocumentoIdentidade("529.982.247-25"), pj), false);
  assert.equal(mesmoDocumento(null, pf), false);
  assert.equal(documentoDoSnapshot({ tipoPessoa: "PJ", cpf: "" }), null);
});
