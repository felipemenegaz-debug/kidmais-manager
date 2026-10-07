import assert from "node:assert/strict";
import test from "node:test";
import { leituraSchema } from "../../comercial/importacao-tabela/esquema.ts";
import { leituraContratoSchema } from "../../contratos/modelo-empresa/leitura.ts";
import { validarLeitura } from "./validar-leitura.ts";

const avisos: string[] = [];
console.warn = (...partes: unknown[]) => { avisos.push(partes.map(String).join(" ")); };

const pacote = {
  nome: "Festa Completa", pagina: 1, descricao: null, selo: null, duracao: null, convidadosMin: 1, convidadosMax: 50, inclusos: [],
  cobranca: "FAIXAS", grades: [{ horario: "UNICO", linhas: [{ de: 1, ate: 50, valor: 9790, rotulo: null }] }], valorPorConvidado: null, aPartirDe: null,
};
const tabela = { pacotes: [pacote], adicionais: [], comuns: [], horarios: [], informacoes: [], naoImportavel: [] };

test("texto e lista acima do limite são aparados no limite; o resto da leitura fica igual", () => {
  const r = leituraSchema.safeParse(tabela);
  assert.ok(r.success, "fixture dentro do schema");
  const longa = { ...tabela, pacotes: [{ ...pacote, selo: "x".repeat(500), inclusos: Array.from({ length: 80 }, (_, i) => `item ${i}`) }] };
  avisos.length = 0;
  const lido = validarLeitura(leituraSchema, JSON.stringify(longa), "tabela de preços");
  assert.equal(lido.pacotes[0].selo?.length, 80);
  assert.equal(lido.pacotes[0].inclusos.length, 60);
  assert.equal(lido.pacotes[0].grades[0].linhas[0].valor, 9790);
  assert.match(avisos.join("\n"), /aparada ao limite.*pacotes\.0\.selo/);
  assert.doesNotMatch(avisos.join("\n"), /x{20}|item 7/, "o log não leva conteúdo do documento");
});

test("divergência que não é tamanho continua recusada, com diagnóstico só de caminho e código", () => {
  avisos.length = 0;
  assert.throws(() => validarLeitura(leituraSchema, JSON.stringify({ ...tabela, pacotes: [{ ...pacote, cobranca: "SEGREDO" }] }), "tabela de preços"));
  assert.match(avisos.join("\n"), /"etapa":"schema".*"caminho":"pacotes\.0\.cobranca"/);
  assert.doesNotMatch(avisos.join("\n"), /SEGREDO/);
  avisos.length = 0;
  assert.throws(() => validarLeitura(leituraSchema, '{"pacotes": [', "tabela de preços"));
  assert.match(avisos.join("\n"), /"etapa":"json","tamanho":13/);
});

test("modelo de contrato: cláusula longa aparada, lista de avisos aparada", () => {
  const conteudo = {
    titulo: "Contrato de Festa", contratada: { nome: "Buffet Alegria", documento: "12.345.678/0001-90", endereco: "Goiânia/GO", representante: "João" },
    preambulo: [], clausulas: [{ titulo: null, texto: "a".repeat(5000) }], observacoes: [], cidadeAssinatura: "Goiânia/GO",
  };
  const lido = validarLeitura(leituraContratoSchema, JSON.stringify({ conteudo, avisos: Array.from({ length: 50 }, () => "aviso") }), "modelo de contrato");
  assert.equal(lido.conteudo.clausulas[0].texto.length, 4000);
  assert.equal(lido.avisos.length, 40);
});
