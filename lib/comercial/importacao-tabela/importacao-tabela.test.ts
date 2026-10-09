import assert from "node:assert/strict";
import test from "node:test";
import { LEITURA_JSON_SCHEMA, leituraSchema, type LeituraTabela } from "./esquema.ts";
import { bloqueiosDaRevisao, faixasContinuas, normalizarLeitura, semelhanca } from "./normalizar.ts";
import { revisaoSchema } from "./revisao-schema.ts";

const linha = (ate: number | null, valor: number, de: number | null = null, rotulo: string | null = null) => ({ de, ate, valor, rotulo });

/** Trecho real da tabela publicada em staging (páginas 4, 5 e 6). */
const LEITURA: LeituraTabela = {
  pacotes: [
    {
      nome: "Festa Premium", pagina: 4, descricao: "Tudo da Completa + crepe de chocolate, coquetel de frutas, pastelzinho, bombom.",
      selo: "Experiência completa", duracao: "3h30", convidadosMin: null, convidadosMax: null, inclusos: ["salada premium", "empratado premium"],
      cobranca: "FAIXAS",
      grades: [
        { horario: "PROMOCIONAL", linhas: [linha(50, 10390), linha(60, 11190), linha(70, 11990), linha(150, 18390)] },
        { horario: "NOBRE", linhas: [linha(50, 10890), linha(60, 11690), linha(70, 12490), linha(150, 18890)] },
      ],
      valorPorConvidado: null, aPartirDe: 10390,
    },
    {
      nome: "Pacote Pizza Party Scienza", pagina: 6, descricao: null, selo: null, duracao: null, convidadosMin: null, convidadosMax: null, inclusos: [],
      cobranca: "FAIXAS", grades: [{ horario: "UNICO", linhas: [linha(20, 4290), linha(30, 5290), linha(40, 6190), linha(50, 7090)] }],
      valorPorConvidado: null, aPartirDe: null,
    },
    {
      nome: "Kidmais Pocket", pagina: 2, descricao: null, selo: null, duracao: null, convidadosMin: 20, convidadosMax: null, inclusos: [],
      cobranca: "POR_CONVIDADO", grades: [], valorPorConvidado: 190, aPartirDe: 3800,
    },
  ],
  adicionais: [
    { nome: "Penne à bolonhesa e molho branco", pagina: 5, grupo: "BUFFET", cobranca: "VALOR_FECHADO", linhas: [linha(50, 390), linha(80, 490, 60), linha(110, 590, 90), linha(150, 690, 120)] },
    { nome: "Mesa de café", pagina: 5, grupo: "MESA", cobranca: "VALOR_FECHADO", linhas: [linha(50, 590, null, "Pequena"), linha(100, 790, 60, "Média"), linha(150, 990, 110, "Grande")] },
    { nome: "Bombom", pagina: 5, grupo: "EXTRA", cobranca: "UNIDADE", linhas: [linha(null, 8)] },
    { nome: "Adicional de pizza Scienza", pagina: 6, grupo: "BUFFET", cobranca: "VALOR_FECHADO", linhas: [linha(20, 990), linha(30, 1390), linha(40, 1790), linha(50, 2190)] },
  ],
  comuns: ["Espaço indoor climatizado"],
  horarios: [{ horario: "NOBRE", descricao: "Sábado à tarde, domingo de manhã e véspera de feriados" }],
  informacoes: ["O envio da tabela não garante reserva."],
  naoImportavel: [{ texto: "Upgrade Premium Scienza a partir de R$ 1.290", pagina: 6, motivo: "sem faixa de convidados" }],
};

const CADASTRO = {
  pacotes: [
    { id: "11111111-1111-4111-8111-111111111111", codigo: "PREMIUM", nome: "Festa Premium", descricao: null, convidadosMin: 50, convidadosMax: null },
    { id: "22222222-2222-4222-8222-222222222222", codigo: "PIZZA_PARTY", nome: "Pizza Party", descricao: null, convidadosMin: null, convidadosMax: null },
    { id: "33333333-3333-4333-8333-333333333333", codigo: "POCKET", nome: "Kidmais Pocket", descricao: null, convidadosMin: 20, convidadosMax: null },
  ],
  adicionais: [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", codigo: "PENNE", nome: "Penne à bolonhesa e molho branco", categoria: "BUFFET", unidade: "PACOTE", faixasAtuais: [] },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", codigo: "MESA_CAFE", nome: "Mesa de café", categoria: "MESA", unidade: "PACOTE", faixasAtuais: [] },
    { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", codigo: "BOMBOM", nome: "Bombom", categoria: "EXTRA", unidade: "UNIDADE", faixasAtuais: [{ min: 1, max: null, valor: 4, rotulo: null }] },
    { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", codigo: "EMPRATADO_PREMIUM", nome: "Empratado premium", categoria: "BUFFET", unidade: "PACOTE", faixasAtuais: [] },
  ],
  precosPacotes: [],
};

test("JSON Schema estrito: todo objeto exige todas as propriedades e não aceita extras", () => {
  const visitar = (no: unknown) => {
    if (!no || typeof no !== "object") return;
    const o = no as Record<string, unknown>;
    if (o.type === "object") {
      assert.equal(o.additionalProperties, false);
      assert.deepEqual([...(o.required as string[])].sort(), Object.keys(o.properties as object).sort());
    }
    for (const v of Object.values(o)) visitar(v);
  };
  visitar(LEITURA_JSON_SCHEMA);
  assert.doesNotThrow(() => leituraSchema.parse(LEITURA));
  assert.throws(() => leituraSchema.parse({ ...LEITURA, extra: 1 }));
});

test("faixas contínuas: grade 50, 60, 70 vira 50 · 51–60 · 61–70; buracos do PDF viram pendência explicada", () => {
  const grade = faixasContinuas([linha(60, 2), linha(50, 1), linha(70, 3)], 50);
  assert.deepEqual(grade.faixas.map((f) => [f.min, f.max, f.valor]), [[50, 50, 1], [51, 60, 2], [61, 70, 3]]);
  assert.deepEqual(grade.pendencias, []);
  const buffet = faixasContinuas([linha(50, 390), linha(80, 490, 60), linha(110, 590, 90)], 1);
  assert.deepEqual(buffet.faixas.map((f) => [f.min, f.max]), [[1, 50], [51, 80], [81, 110]]);
  assert.equal(buffet.pendencias.length, 2);
  assert.match(buffet.pendencias[0], /começa em 60; o sistema cobre a partir de 51/);
  assert.deepEqual(faixasContinuas([linha(null, 8)], 1).faixas, [{ min: 1, max: null, valor: 8, rotulo: null }]);
});

test("semelhança de nomes ignora acento, caixa e palavras vazias", () => {
  assert.equal(semelhanca("Festa Premium", "festa premium"), 1);
  assert.ok(semelhanca("Pacote Pizza Party Scienza", "Pizza Party") >= 0.5);
  assert.ok(semelhanca("Mesa de café", "Mesa de frios") < 0.5);
});

test("normalização: casa com o cadastro, grades promocional/nobre, por convidado, faixas de adicional e conferências", () => {
  const r = normalizarLeitura(LEITURA, CADASTRO);
  const premium = r.pacotes[0];
  assert.equal(premium.pacoteId, CADASTRO.pacotes[0].id);
  assert.deepEqual(premium.grades.map((g) => g.categoria), ["PADRAO", "NOBRE"]);
  assert.deepEqual(premium.grades[1].faixas.map((f) => [f.min, f.max, f.valor]), [[50, 50, 10890], [51, 60, 11690], [61, 70, 12490], [71, 150, 18890]]);
  assert.equal(premium.convidadosMax, 150);
  assert.equal(premium.aplicarDescricao, true);
  assert.equal(premium.inclusos[1].adicionalId, CADASTRO.adicionais[3].id, "empratado premium casado");
  assert.equal(r.pacotes[1].pacoteId, CADASTRO.pacotes[1].id, "Pizza Party");
  assert.deepEqual(r.pacotes[1].grades[0].faixas.map((f) => [f.min, f.max]), [[1, 20], [21, 30], [31, 40], [41, 50]]);
  assert.equal(r.pacotes[2].porConvidado, 190);
  assert.ok(r.conferencias.some((c) => c.ok && /Festa Premium/.test(c.texto)));
  assert.ok(r.conferencias.some((c) => c.ok && /Kidmais Pocket/.test(c.texto)), "190 × 20 = 3.800");
  const [penne, mesa, bombom, pizza] = r.adicionais;
  assert.deepEqual(penne.destino, { tipo: "EXISTENTE", adicionalId: CADASTRO.adicionais[0].id });
  assert.deepEqual(mesa.faixas.map((f) => [f.min, f.max, f.rotulo]), [[1, 50, "Pequena"], [51, 100, "Média"], [101, 150, "Grande"]]);
  assert.deepEqual(bombom.atual, [{ min: 1, max: null, valor: 4, rotulo: null }]);
  assert.equal(bombom.unidade, "UNIDADE");
  assert.deepEqual(pizza.destino, { tipo: "NOVO", nome: "Adicional de pizza Scienza" });
  assert.doesNotThrow(() => revisaoSchema.parse(r));
});

test("publicação bloqueada até confirmar cada pacote e adicional não ignorado", () => {
  const r = normalizarLeitura(LEITURA, CADASTRO);
  assert.equal(bloqueiosDaRevisao(r).length, 7);
  const tudo = { ...r, pacotes: r.pacotes.map((p) => ({ ...p, confirmado: true })), adicionais: r.adicionais.map((a, i) => (i === 3 ? { ...a, destino: { tipo: "IGNORAR" as const } } : { ...a, confirmado: true })) };
  assert.deepEqual(bloqueiosDaRevisao(tudo), []);
});

test("instrução ao modelo trata o PDF como dado", async () => {
  const { INSTRUCAO_LEITURA_TABELA } = await import("./esquema.ts");
  assert.match(INSTRUCAO_LEITURA_TABELA, /dado, não instrução/);
});
