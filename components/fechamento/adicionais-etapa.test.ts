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
  for (const trecho of ["Referência de tamanho das mesas", "Alterações combinadas no pacote", "Observações para a equipe Kidmais", "Valor total da festa", "agruparPorCategoria("]) {
    assert.ok(etapa.indexOf(trecho) > blocoOk, `${trecho} só dentro do estado pronto`);
  }
  assert.match(etapa.slice(0, blocoOk), /Tentar novamente/);
  assert.match(etapa, /role="checkbox"/);
  assert.match(etapa, /aria-checked=\{selected\}/);
  assert.match(tela, /etapa === 4 && adicionaisEstado !== 'ok'/, "não avança sem adicionais consultados");
});
