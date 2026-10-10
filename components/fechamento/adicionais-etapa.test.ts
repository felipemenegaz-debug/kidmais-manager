import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { agruparPorCategoria, lerAdicionaisDisponiveis } from "./adicionais-etapa.ts";

test("resposta de erro da API (ex.: catálogo público fechado) ou formato inesperado ⇒ erro, nunca lista parcial", () => {
  assert.equal(lerAdicionaisDisponiveis({ erro: "O catálogo público não comprova a empresa...", codigo: "CATALOGO_PUBLICO_INDETERMINADO" }), null);
  assert.equal(lerAdicionaisDisponiveis(null), null);
  assert.equal(lerAdicionaisDisponiveis({ adicionais: [{ id: "x", nome: "X", categoria: "MESA", preco: -1, unidadeCobranca: "FIXO" }] }), null, "preço negativo");
  assert.deepEqual(lerAdicionaisDisponiveis({ adicionais: [] }), []);
});

test("só categorias com adicionais viram seção: nada de título vazio", () => {
  const grupos = agruparPorCategoria([
    { id: "mesa-cafe-p", nome: "Mesa de café", categoria: "MESA", preco: 350, unidadeCobranca: "FIXO" },
    { id: "bebida", nome: "Suco", categoria: "BEBIDA", preco: 50, unidadeCobranca: "FIXO" },
  ]);
  assert.deepEqual(grupos.map((g) => g.titulo), ["Mesas especiais", "Outros adicionais"]);
  assert.deepEqual(agruparPorCategoria([]), []);
});

test("etapa 4: em erro/carregando não aparecem títulos, totais nem campos de personalização; há 'Tentar novamente'", () => {
  const tela = readFileSync("components/fechamento/FechamentoWizard.tsx", "utf8").replace(/\r\n/g, "\n");
  const inicio = tela.indexOf('titulo="Quer adicionar algo à festa?"');
  const fim = tela.indexOf("{etapa === 5 && (", inicio);
  const etapa = tela.slice(inicio, fim);
  const blocoOk = etapa.indexOf('{adicionaisEstado === "ok" && (');
  assert.ok(blocoOk > 0);
  for (const trecho of ["Referência de tamanho das mesas", "Alterações combinadas no pacote", "Observações para a {marca.equipe}", "Valor total da festa", "agruparPorCategoria("]) {
    assert.ok(etapa.indexOf(trecho) > blocoOk, `${trecho} só dentro do estado pronto`);
  }
  assert.match(etapa.slice(0, blocoOk), /Tentar novamente/);
  assert.match(etapa, /role="checkbox"/);
  assert.match(etapa, /aria-checked=\{selected\}/);
  assert.match(tela, /etapa === 4 && adicionaisEstado !== 'ok'/, "não avança sem adicionais consultados");
});

test("unidade de cobrança: rótulo, quantidade e total iguais ao cálculo do servidor", async () => {
  const { aceitaQuantidade, rotuloUnidade, totalDoAdicional } = await import("./adicionais-etapa.ts");
  assert.equal(rotuloUnidade("CENTO"), " / cento");
  assert.equal(rotuloUnidade("PACOTE"), "");
  assert.equal(aceitaQuantidade("CENTO"), true);
  assert.equal(aceitaQuantidade("PACOTE"), false);
  assert.equal(totalDoAdicional({ preco: 120, unidadeCobranca: "CENTO" }, 3, 50), 360);
  assert.equal(totalDoAdicional({ preco: 4.5, unidadeCobranca: "CONVIDADO" }, 1, 40), 180);
  assert.equal(totalDoAdicional({ preco: 350, unidadeCobranca: "PACOTE" }, 1, 40), 350);
});

test("adicional de categoria: escolhas validadas na resposta e exigidas na seleção, respeitando o máximo", async () => {
  const { pendenciaEscolhas, mensagemFalhaAdicionais } = await import("./adicionais-etapa.ts");
  const cento = { id: "CATEGORIA_SALGADOS", nome: "Cento de salgados extra", categoria: "BUFFET", preco: 120, unidadeCobranca: "CENTO", escolhas: { max: 2, itens: [{ id: "a", nome: "Coxinha" }, { id: "b", nome: "Kibe" }, { id: "c", nome: "Esfiha" }] } };
  assert.deepEqual(lerAdicionaisDisponiveis({ adicionais: [cento] }), [cento]);
  assert.equal(lerAdicionaisDisponiveis({ adicionais: [{ ...cento, escolhas: { max: 0, itens: [] } }] }), null);
  assert.match(pendenciaEscolhas(cento, []) ?? "", /Escolha as opções/);
  assert.match(pendenciaEscolhas(cento, ["a", "b", "c"]) ?? "", /no máximo 2/);
  assert.equal(pendenciaEscolhas(cento, ["a"]), null);
  assert.equal(pendenciaEscolhas({ ...cento, escolhas: undefined }, []), null);
  assert.match(mensagemFalhaAdicionais("PRECO_INDISPONIVEL", true), /Tabelas de preço/);
  assert.doesNotMatch(mensagemFalhaAdicionais("PRECO_INDISPONIVEL"), /Configurações/);
});
