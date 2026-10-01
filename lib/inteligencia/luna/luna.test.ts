import assert from "node:assert/strict";
import test from "node:test";
import type { RespostaLeitura } from "../contratos.ts";
import { mensagensEntendimento, revalidar, schemaEntendimento, type SaidaLuna } from "./entendimento.ts";
import { conferirRedacao } from "./redacao.ts";

/** Saída da Luna com tudo vazio; cada teste preenche só o que importa. */
function saidaLuna(parcial: Omit<Partial<SaidaLuna>, "consumo" | "contratacao"> & { consumo?: Partial<SaidaLuna["consumo"]>; contratacao?: Partial<SaidaLuna["contratacao"]> } = {}): SaidaLuna {
  return {
    objetivo: "CONSULTA", acao: null, relacaoRascunho: "SEM_RASCUNHO", correcao: false, consultas: [], festa: "NENHUMA", dataFesta: null,
    esclarecimento: null, outrosPedidos: [],
    ...parcial,
    consumo: { categorias: [], docesPorConvidado: null, mlPorConvidado: null, embalagemMl: null, margemPercentual: null, estimar: [], docesEstimado: null, mlEstimado: null, ...parcial.consumo },
    contratacao: { cliente: null, pacote: null, convidados: null, aniversariante: null, idade: null, tema: null, data: null, diaMes: null, turno: null, horario: null, ...parcial.contratacao },
  };
}

const CATALOGO = { consultas: [{ id: "proximas_festas", descricao: "x" }, { id: "resumir_festa", descricao: "y" }], acoes: [{ id: "criar_pacote", descricao: "z" }] };
const entrada = (texto: string, historico: Array<{ pergunta: string; resposta: string }> = []) => ({ texto, historico, ...CATALOGO });

test("Luna: caso C — 4 doces, embalagem de 2l e estimativa PEDIDA são aceitos; nada é perguntado de novo", () => {
  const texto = "4 doces por convidados, refrigerante de 2l. Não sei dizer quantos ml por convidados o consumo. faça você a definição.";
  const e = revalidar(saidaLuna({ objetivo: "CALCULO_CONSUMO", festa: "DA_CONVERSA", consumo: { categorias: ["DOCES", "REFRIGERANTES"], docesPorConvidado: 4, embalagemMl: 2000, estimar: ["REFRIGERANTES"], mlEstimado: 350 } }), entrada(texto));
  assert.equal(e.consumo.docesPorConvidado, 4);
  assert.equal(e.consumo.embalagemMl, 2000, "2l ⇒ 2000 mL, conferido contra o texto");
  assert.equal(e.consumo.mlPorConvidado, null);
  assert.deepEqual(e.consumo.estimativa, { mlPorConvidado: 350 });
  assert.deepEqual(e.descartes, []);
});

test("Luna: número que o usuário não escreveu é descartado; estimativa sem pedido explícito também", () => {
  const e = revalidar(saidaLuna({ objetivo: "CALCULO_CONSUMO", consumo: { categorias: ["REFRIGERANTES"], mlPorConvidado: 400, embalagemMl: 2000, estimar: ["REFRIGERANTES"], mlEstimado: 300 } }), entrada("quantos refrigerantes a próxima festa precisa?"));
  assert.equal(e.consumo.mlPorConvidado, null);
  assert.equal(e.consumo.embalagemMl, null);
  assert.deepEqual(e.consumo.estimativa, {});
  assert.deepEqual(e.descartes.sort(), ["embalagemMl", "estimativa_sem_pedido", "mlPorConvidado"]);
  // Volume em litros com vírgula: "1,5 l" ⇒ 1500 mL.
  assert.equal(revalidar(saidaLuna({ consumo: { embalagemMl: 1500 } }), entrada("garrafa de 1,5 l")).consumo.embalagemMl, 1500);
});

test("Luna: nomes, pacote e convidados só do que o usuário escreveu (mensagem ou histórico); data sem ano vira dia/mês", () => {
  const texto = "crie uma do cliente Felipe para 50 convidados, pacote premium, dia 15/11";
  const e = revalidar(saidaLuna({ objetivo: "PREPARAR_CONTRATACAO", contratacao: { cliente: "Felipe", convidados: 50, pacote: "premium", aniversariante: "Beatriz", data: "2026-11-15" } }), entrada(texto));
  assert.deepEqual(e.contratacao, { cliente: "Felipe", pacote: "premium", convidados: 50, diaMes: "15/11" });
  assert.deepEqual(e.descartes.sort(), ["aniversariante", "data"], "Beatriz não foi escrita; o ano 2026 também não");
  // Elipse resolvida pelo histórico: os dados ditos antes valem.
  const h = revalidar(saidaLuna({ objetivo: "PREPARAR_CONTRATACAO", correcao: true, relacaoRascunho: "TROCA_OBJETIVO", contratacao: { cliente: "Felipe", convidados: 50, pacote: "premium" } }),
    entrada("Quero criar uma festa e não um pacote", [{ pergunta: "crie uma do cliente Felipe para 50 convidados, pacote premium", resposta: "Qual é o preço do pacote?" }]));
  assert.deepEqual(h.contratacao, { cliente: "Felipe", pacote: "premium", convidados: 50 });
});

test("Luna: \"pacote\" como atributo de um pedido sobre cliente/festa nunca vira criar_pacote (vira esclarecimento)", () => {
  const e = revalidar(saidaLuna({ objetivo: "ACAO", acao: "criar_pacote" }), entrada("crie uma do cliente Felipe para 50 convidados, pacote premium"));
  assert.equal(e.objetivo, "ESCLARECER");
  assert.equal(e.acao, null);
  assert.ok(e.descartes.includes("criar_pacote_por_atributo"));
  // Pedido explícito de pacote continua sendo pacote.
  assert.equal(revalidar(saidaLuna({ objetivo: "ACAO", acao: "criar_pacote" }), entrada("crie um pacote chamado Premium")).acao, "criar_pacote");
});

test("Luna: consultas e ações fora do catálogo do operador são descartadas; ação inexistente não vira ação", () => {
  const e = revalidar(saidaLuna({ consultas: ["proximas_festas", "executar_sql", "proximas_festas"] }), entrada("quais as próximas festas?"));
  assert.deepEqual(e.consultas, ["proximas_festas"]);
  const a = revalidar(saidaLuna({ objetivo: "ACAO", acao: "excluir_tudo" }), entrada("apague tudo"));
  assert.equal(a.objetivo, "FORA_DO_ESCOPO");
});

test("Luna: o schema enviado é estrito e fechado (enums do catálogo, todos os campos obrigatórios)", () => {
  const s = schemaEntendimento(["proximas_festas"], ["criar_pacote"]) as { additionalProperties: boolean; required: string[]; properties: Record<string, { enum?: unknown[]; items?: { enum?: unknown[] } }> };
  assert.equal(s.additionalProperties, false);
  assert.equal(s.required.length, Object.keys(s.properties).length);
  assert.deepEqual(s.properties.consultas.items?.enum, ["proximas_festas"]);
  assert.deepEqual(s.properties.acao.enum, ["criar_pacote", null]);
});

test("Luna: o que vai ao modelo é minimizado (sem CPF/telefone/e-mail/ids) e o histórico é limitado", () => {
  const m = mensagensEntendimento({
    texto: "cliente com CPF 123.456.789-09 e fone (11) 98765-4321, id 0b9f6c3e-1111-4111-8111-000000000000",
    hoje: "2026-10-01", contexto: null, rascunho: null, consumoPendente: null, consultas: [], acoes: [],
    historico: Array.from({ length: 6 }, (_, i) => ({ pergunta: `p${i} maria@x.com`, resposta: `r${i}` })),
  });
  const dados = m[1].conteudo;
  for (const proibido of ["123.456.789-09", "98765-4321", "0b9f6c3e-1111", "maria@x.com"]) assert.equal(dados.includes(proibido), false, proibido);
  assert.equal((JSON.parse(dados) as { historico: unknown[] }).historico.length, 4);
});

const resposta = (fatos: Array<[RespostaLeitura["fatos"][number]["natureza"], string]>): RespostaLeitura => ({
  capacidade: "calcular_consumo", estado: "informativo", resumo: "Total: 20 L = 10 embalagens de 2 L para 50 convidados.", itens: [], evidencias: [],
  referencia: { hoje: "2026-10-01", geradoEm: "2026-10-01T00:00:00Z", fontes: [] },
  fatos: fatos.map(([natureza, texto]) => ({ natureza, texto, fonte: "x" })),
  entidades: [{ tipo: "FESTA", id: "33333333-3333-4333-8333-000000000001", rotulo: "Festa — 01/10/2026" }],
});

test("Redação: só números que existem nos fatos; links e marcação reprovam; texto válido passa limpo", () => {
  const r = resposta([["CALCULO", "50 convidados × 400 mL = 20.000 mL = 20 L."], ["CALCULO", "20.000 mL ÷ 2 L por embalagem = 10 embalagens."]]);
  const pergunta = "quantos refrigerantes?";
  const bom = "Para a festa de 01/10/2026, com 50 convidados: 20 L, ou seja, 10 garrafas de 2 L (20.000 mL).";
  assert.equal(conferirRedacao(bom, { pergunta, resposta: r }), bom);
  // Os resultados do sistema não podem sumir: sem o total (10 embalagens), reprovado.
  assert.equal(conferirRedacao("Para 50 convidados: 20 L de refrigerante em garrafas de 2 L.", { pergunta, resposta: r }), null);
  assert.equal(conferirRedacao("São 12 garrafas.", { pergunta, resposta: r }), null, "12 não existe nos fatos");
  assert.equal(conferirRedacao("Veja https://exemplo.com", { pergunta, resposta: r }), null);
  assert.equal(conferirRedacao("<b>10</b> garrafas", { pergunta, resposta: r }), null);
  assert.equal(conferirRedacao("   ", { pergunta, resposta: r }), null);
});
