import assert from "node:assert/strict";
import test from "node:test";
import { type FormularioAdicional, formularioAdicional, pedidoAdicional, precoDoCampo, precoNaLista, type AdicionalAdmin } from "./catalogo-adicionais.ts";

const pacotes = [{ id: "p1", codigo: "POCKET", nome: "Kidmais Pocket" }, { id: "p2", codigo: "PREMIUM", nome: "Festa Premium" }];

test("preço do campo: formatos brasileiros, vazio tira o preço e texto inválido é recusado", () => {
  assert.equal(precoDoCampo("1.234,56"), "1234.56");
  assert.equal(precoDoCampo("80"), "80.00");
  assert.equal(precoDoCampo("R$ 12,5"), "12.50");
  assert.equal(precoDoCampo(""), null);
  assert.equal(precoDoCampo("abc"), undefined);
  assert.equal(precoDoCampo("1,234"), undefined);
});

test("categoria nova: adicional único, cobrança por cento, nenhum pacote marcado até escolher", () => {
  const form = formularioAdicional(null, { tipo: "CATEGORIA", id: "cat", nome: "Salgados" }, { pacotes });
  assert.equal(form.nome, "Salgados extra");
  assert.equal(form.unidadeCobranca, "CENTO");
  assert.equal(form.categoria, "BUFFET");
  assert.deepEqual(form.pacotes, { p1: "INDISPONIVEL", p2: "INDISPONIVEL" });
  const pedido = pedidoAdicional({ ...form, preco: "120,00", escolhasMax: "4", pacotes: { ...form.pacotes, p1: "EXTRA" } as FormularioAdicional["pacotes"] });
  assert.deepEqual(pedido, {
    origem: { tipo: "CATEGORIA", id: "cat" }, nome: "Salgados extra", categoria: "BUFFET", unidadeCobranca: "CENTO", ativo: true,
    escolhasMax: 4, preco: "120.00", pacotes: { p1: "EXTRA" },
  });
});

test("edição: preço e pacotes só vão quando mudam; máximo inválido e nome vazio são recusados", () => {
  const existente: AdicionalAdmin = {
    id: "a1", codigo: "MESA_CAFE", nome: "Mesa de café", categoria: "MESA", unidadeCobranca: "PACOTE", ativo: true,
    origem: null, escolhasMax: null, preco: "350.00", faixasPreco: 1, pacotes: { p2: "EXTRA" },
  };
  const form = formularioAdicional(existente, null, { pacotes });
  assert.equal(form.preco, "350,00");
  assert.deepEqual(pedidoAdicional(form), { id: "a1", nome: "Mesa de café", categoria: "MESA", unidadeCobranca: "PACOTE", ativo: true });
  assert.deepEqual(pedidoAdicional({ ...form, preco: "" }), { id: "a1", nome: "Mesa de café", categoria: "MESA", unidadeCobranca: "PACOTE", ativo: true, preco: null });
  assert.equal(typeof pedidoAdicional({ ...form, nome: " " }), "string");
  const cat = formularioAdicional(null, { tipo: "CATEGORIA", id: "cat", nome: "Doces" }, { pacotes });
  assert.equal(typeof pedidoAdicional({ ...cat, escolhasMax: "40" }), "string");
  assert.equal(precoNaLista(existente), "R$ 350,00");
  assert.equal(precoNaLista({ ...existente, unidadeCobranca: "CENTO", preco: "120.00" }), "R$ 120,00 por cento");
  assert.equal(precoNaLista({ ...existente, preco: null, faixasPreco: 3 }), "Preço por faixa");
  assert.equal(precoNaLista({ ...existente, preco: null, faixasPreco: 0 }), "Sem preço");
});
