import assert from "node:assert/strict";
import test from "node:test";
import type { SituacaoRascunho } from "../extensoes.ts";
import { interpretarDeterministico } from "../intencao.ts";
import { calcularDoces, calcularRefrigerantes, detectarConsumo, extrairParametros, litros, pedeSalvarParametro } from "./consumo.ts";
import { coordenarRascunho, correcaoDeObjetivo, objetoDeCriacao } from "./objetivo.ts";
import { extrairContratacao, faltandoContratacao, validarContratacao } from "../acoes/contratacao.ts";

/** IA operacional — unidades determinísticas: objetivo principal, coordenação, parâmetros e cálculos. */

test("objeto principal: festa com pacote como atributo prepara contratação; pacote explícito continua pacote", () => {
  const exata = "crie uma festa do Felipe, pacote premium 50 convidados, beatriz 1 ano; tema unicórnio";
  assert.equal(objetoDeCriacao(exata), "FESTA");
  assert.deepEqual(interpretarDeterministico(exata, null), { tipo: "acao", capacidade: "preparar_contratacao", origem: "INTENCAO_DETERMINISTICA" });
  assert.equal(objetoDeCriacao("Crie um pacote chamado Premium"), "PACOTE");
  assert.equal(interpretarDeterministico("Crie um pacote chamado Premium por R$ 4.500", null).tipo, "acao");
  assert.equal((interpretarDeterministico("Crie um pacote chamado Premium por R$ 4.500", null) as { capacidade: string }).capacidade, "criar_pacote");
  assert.equal(objetoDeCriacao("Quero criar uma festa e não um pacote"), "FESTA");
  assert.equal(correcaoDeObjetivo("Quero criar uma festa e não um pacote"), "FESTA");
  assert.equal(correcaoDeObjetivo("não é pacote, é uma festa"), "FESTA");
  assert.equal(correcaoDeObjetivo("é um pacote, não uma festa"), "PACOTE");
  // O objeto é o primeiro substantivo depois do verbo: tarefa/observação numa festa não é criar festa.
  assert.equal(objetoDeCriacao("Crie uma tarefa nesta festa: confirmar a decoração"), null);
  assert.equal(objetoDeCriacao("Adicione uma observação nesta festa"), null);
  assert.equal(objetoDeCriacao("prepare a contratação do Felipe"), "FESTA");
  assert.equal(objetoDeCriacao("nova festa da Ana"), "FESTA");
  assert.equal(objetoDeCriacao("crie um pacote para a festa de verão"), "PACOTE");
  // Teste de Felipe em staging (23/10): "fechar/fazer um contrato" é contratação; contrato já existente não é.
  for (const t of ["quero fechar um contrato", "Quero fechar um contrato novo", "fechar contrato", "vamos fazer um contrato", "faça um novo contrato para a Ana",
    "quero contratar uma festa", "fechar uma festa para o Felipe"]) {
    assert.equal(objetoDeCriacao(t), "FESTA", t);
    assert.deepEqual(interpretarDeterministico(t, null), { tipo: "acao", capacidade: "preparar_contratacao", origem: "INTENCAO_DETERMINISTICA" }, t);
  }
  // Parecer do Astra (23/10, P2): verbo negado não inicia contratação; "não, quero…" (vírgula) continua pedido.
  assert.equal(objetoDeCriacao("não, quero fechar um contrato"), "FESTA");
  // Rodada 2: negação em qualquer ponto da oração; outra oração positiva depois continua valendo.
  assert.equal(objetoDeCriacao("não quero criar um pacote, quero fechar um contrato"), "FESTA");
  assert.equal(objetoDeCriacao("não sei o preço ainda, mas quero fechar um contrato"), "FESTA");
  assert.equal(objetoDeCriacao("Não. Quero fechar um contrato para a Ana"), "FESTA");
  for (const t of ["fechar o contrato da Ana", "quero fechar este contrato", "fazer o contrato do Felipe", "gere o contrato", "importar contrato antigo", "como faço um contrato?",
    "não quero fechar um contrato", "não faça um contrato", "nao vamos criar uma festa agora", "não quero contratar uma festa", "eu não vou fechar contrato hoje",
    "não quero que você faça um contrato", "não tenho intenção de fechar um contrato", "nunca mais quero fechar contrato por aqui", "nem pense em criar uma festa",
    // Rodada 3: coordenação e inciso não encerram a negação.
    "não quero criar um pacote ou fechar um contrato", "não quero, por enquanto, fechar um contrato", "não, não quero fechar contrato",
    "não quero criar uma festa nem fechar um contrato", "não vou, pelo menos hoje, fazer um contrato"]) {
    assert.notEqual(objetoDeCriacao(t), "FESTA", t);
    assert.notEqual((interpretarDeterministico(t, null) as { capacidade?: string }).capacidade, "preparar_contratacao", t);
  }
  // Perguntas e referências nunca viram criação.
  for (const t of ["quantos docinhos devo fazer para a próxima festa?", "quem vai montar a festa de sábado?", "como crio uma festa?", "o que precisa fazer na festa de amanhã?", "qual pacote a próxima festa usa?"]) {
    assert.equal(objetoDeCriacao(t), null, t);
    assert.notEqual((interpretarDeterministico(t, null) as { capacidade?: string }).capacidade, "preparar_contratacao", t);
    assert.notEqual((interpretarDeterministico(t, null) as { capacidade?: string }).capacidade, "criar_pacote", t);
  }
});

test("escopo da negação (Astra, rodada 3): negativas variadas nunca contratam; afirmativas com 'não' noutra oração contratam", () => {
  const negativas = ["não quero mais fechar contrato", "não preciso que você feche um contrato", "eu não pedi para fechar um contrato", "não é para fechar um contrato",
    "não vamos, por ora, criar uma festa", "não quero criar festa e nem fechar contrato", "jamais feche um contrato sem me avisar", "nunca crie uma festa sozinho",
    "não, não faça um contrato", "não quero agora fechar um contrato", "nao desejo fechar contrato", "não precisa fechar um contrato", "não quero criar, nem fechar um contrato"];
  const positivas = ["não quero pacote; quero fechar um contrato", "fechar contrato para a Ana, não um pacote", "não quero esperar, vamos fechar um contrato",
    "crie uma festa e não um pacote", "não, pode fechar um contrato"];
  for (const t of negativas) assert.notEqual(objetoDeCriacao(t), "FESTA", t);
  for (const t of positivas) assert.equal(objetoDeCriacao(t), "FESTA", t);
});

test("decisão final (Astra, rodada 4): negativas nunca contratam nem trocam o objetivo, em objeto, correção, intenção e coordenador", () => {
  const capacidade = (t: string) => (interpretarDeterministico(t, null) as { capacidade?: string }).capacidade;
  const coordena = (t: string) => coordenarRascunho(t, situacao(), interpretarDeterministico(t, null), false).tipo;
  for (const t of ["não quero criar uma festa e não um pacote", "não quero, então, fechar um contrato", "não quero criar um pacote ou fechar um contrato",
    "não quero, por enquanto, fechar um contrato", "não quero fechar um contrato nem criar um pacote", "não quero, então, criar uma festa e não um pacote"]) {
    assert.notEqual(objetoDeCriacao(t), "FESTA", t);
    assert.notEqual(correcaoDeObjetivo(t), "FESTA", t);
    assert.ok(!["preparar_contratacao", "criar_pacote"].includes(capacidade(t) ?? ""), `${t}: ${capacidade(t)}`);
    assert.notEqual(coordena(t), "MUDANCA_OBJETIVO", t);
  }
  // Controles positivos: a mesma estrutura com o alvo afirmado continua trocando.
  for (const [t, objetivo] of [["quero criar uma festa e não um pacote", "preparar_contratacao"], ["não é pacote, é uma festa", "preparar_contratacao"],
    ["não quero esperar, vamos fechar um contrato", "preparar_contratacao"], ["não quero esperar, então feche um contrato", "preparar_contratacao"],
    ["não, quero fechar um contrato", "preparar_contratacao"]] as const) {
    assert.equal(capacidade(t), objetivo, t);
    assert.deepEqual(coordenarRascunho(t, situacao(), interpretarDeterministico(t, null), false), { tipo: "MUDANCA_OBJETIVO", capacidade: objetivo }, t);
  }
  assert.equal(correcaoDeObjetivo("é um pacote, não uma festa"), "PACOTE");
  assert.equal(correcaoDeObjetivo("não é pacote, é uma festa"), "FESTA");
  assert.equal(capacidade("quero criar um pacote chamado Premium"), "criar_pacote");
});

const situacao = (s: Partial<SituacaoRascunho> = {}): SituacaoRascunho => ({
  capacidade: "criar_pacote", ferramenta: "comercial.criar_pacote", titulo: "Novo pacote", aberto: true, perguntado: "precoCentavos",
  pergunta: "Qual é o preço do pacote?", respondeCampo: false, trazDados: false, ...s,
});

test("coordenador: resposta, correção, troca de objetivo, consulta, cancelar, retomar e ambiguidade", () => {
  const r = (texto: string, s: Partial<SituacaoRascunho> = {}, consulta = false) => coordenarRascunho(texto, situacao(s), interpretarDeterministico(texto, null), consulta).tipo;
  assert.equal(r("R$ 4.500", { respondeCampo: true }), "RESPOSTA_CAMPO");
  assert.equal(r("Quero criar uma festa e não um pacote"), "MUDANCA_OBJETIVO");
  assert.deepEqual(coordenarRascunho("Quero criar uma festa e não um pacote", situacao(), interpretarDeterministico("x", null), false), { tipo: "MUDANCA_OBJETIVO", capacidade: "preparar_contratacao" });
  // Parecer do Astra (23/10, rodada 2): com rascunho de pacote aberto, negativa nunca troca o objetivo; o pedido troca.
  for (const t of ["não quero que você faça um contrato", "não tenho intenção de fechar um contrato", "não quero fechar um contrato",
    "não quero criar um pacote ou fechar um contrato", "não quero, por enquanto, fechar um contrato"]) {
    assert.notEqual(r(t), "MUDANCA_OBJETIVO", t);
  }
  assert.deepEqual(coordenarRascunho("quero fechar um contrato", situacao(), interpretarDeterministico("quero fechar um contrato", null), false), { tipo: "MUDANCA_OBJETIVO", capacidade: "preparar_contratacao" });
  assert.equal(r("quantos docinhos devo fazer para a próxima festa?", {}, true), "NOVA_CONSULTA");
  assert.equal(r("Quantos refrigerantes a próxima festa vai precisar?", {}, true), "NOVA_CONSULTA");
  assert.equal(r("quais contratos estão pendentes?"), "NOVA_CONSULTA");
  assert.equal(r("cancelar"), "CANCELAR");
  assert.equal(r("deixa pra lá"), "CANCELAR");
  assert.equal(r("retomar o rascunho"), "RETOMAR");
  assert.equal(r("continuar"), "RETOMAR");
  assert.equal(r("na verdade de 40 a 90 convidados", { trazDados: true }), "CORRECAO");
  assert.equal(r("50?", { perguntado: "convidadosMinimos", respondeCampo: true }), "AMBIGUO");
  assert.equal(r("qualquer coisa", { aberto: false }), "ENCERRADO");
  // Mesmo objetivo de novo ⇒ correção dos dados; nunca abre outro rascunho em paralelo.
  assert.equal(r("crie o pacote Festa Plus"), "CORRECAO");
  // Rascunho de contratação: "crie um pacote X" é troca explícita de objetivo.
  assert.equal(r("crie um pacote chamado Festa Plus", { capacidade: "preparar_contratacao" }), "MUDANCA_OBJETIVO");
});

test("consumo: detecção por vocabulário fechado; salvar como padrão é outro pedido", () => {
  assert.deepEqual(detectarConsumo("quantos docinhos devo fazer para a próxima festa?"), { categorias: ["DOCES"] });
  assert.deepEqual(detectarConsumo("Quantos refrigerantes a próxima festa vai precisar?"), { categorias: ["REFRIGERANTES"] });
  assert.deepEqual(detectarConsumo("4 docinhos por convidado para a próxima festa"), { categorias: ["DOCES"] });
  assert.equal(detectarConsumo("salvar 4 docinhos por convidado como padrão"), null);
  assert.equal(detectarConsumo("quantos convidados tem a próxima festa?"), null);
  assert.equal(pedeSalvarParametro("salvar 4 docinhos por convidado como padrão"), true);
  assert.equal(pedeSalvarParametro("quantos docinhos devo fazer?"), false);
});

test("consumo: parâmetros só do que foi escrito (inteiros, mL), nunca do nome do pacote", () => {
  assert.deepEqual(extrairParametros("4 doces por convidado", "DOCES"), { porConvidado: 4 });
  assert.deepEqual(extrairParametros("4", "DOCES", "POR_CONVIDADO"), { porConvidado: 4 });
  assert.deepEqual(extrairParametros("4", "DOCES"), {});
  assert.deepEqual(extrairParametros("400 ml por convidado e garrafas de 2 litros", "REFRIGERANTES"), { mlPorConvidado: 400, embalagemMl: 2000 });
  assert.deepEqual(extrairParametros("0,4 l por pessoa, garrafa de 2L", "REFRIGERANTES"), { mlPorConvidado: 400, embalagemMl: 2000 });
  assert.deepEqual(extrairParametros("2 litros", "REFRIGERANTES", "EMBALAGEM"), { embalagemMl: 2000 });
  assert.deepEqual(extrairParametros("350ml", "REFRIGERANTES", "ML_POR_CONVIDADO"), { mlPorConvidado: 350 });
  // Resposta à pergunta da taxa com a embalagem junto: o volume solto é a taxa; o da garrafa, a embalagem.
  assert.deepEqual(extrairParametros("400 mL e garrafas de 2 litros", "REFRIGERANTES", "ML_POR_CONVIDADO"), { mlPorConvidado: 400, embalagemMl: 2000 });
  assert.deepEqual(extrairParametros("garrafa de 2 litros, 400 ml", "REFRIGERANTES", "ML_POR_CONVIDADO"), { mlPorConvidado: 400, embalagemMl: 2000 });
  // Perguntada a embalagem e já escrita com papel explícito: o volume solto não é reatribuído a nada.
  assert.deepEqual(extrairParametros("garrafa de 2 litros e 400 ml", "REFRIGERANTES", "EMBALAGEM"), { embalagemMl: 2000 });
  // Dois volumes soltos: ambíguo, nada é escolhido.
  assert.deepEqual(extrairParametros("400 ml ou 350 ml", "REFRIGERANTES", "ML_POR_CONVIDADO"), {});
  assert.deepEqual(extrairParametros("pacote premium", "REFRIGERANTES"), {});
  assert.deepEqual(extrairParametros("4 por convidado com margem de 10%", "DOCES"), { porConvidado: 4, margemPercentual: 10 });
  assert.deepEqual(extrairParametros("4 por convidado, 50% brigadeiro, 30% beijinho e 20% cajuzinho", "DOCES").distribuicao, [
    { tipo: "brigadeiro", percentual: 50 }, { tipo: "beijinho", percentual: 30 }, { tipo: "cajuzinho", percentual: 20 },
  ]);
});

test("cálculo: 50 × 4 = 200; margem e divisão só se informadas; total conservado", () => {
  const r = calcularDoces(50, 4);
  assert.equal(r.total, 200);
  assert.equal(r.tipo === "CALCULADO" && r.distribuicao, null);
  assert.deepEqual(r.formula, ["50 convidados × 4 = 200 docinhos."]);
  const m = calcularDoces(50, 4, 10);
  assert.equal(m.total, 220);
  const d = calcularDoces(50, 4, undefined, [{ tipo: "brigadeiro", percentual: 34 }, { tipo: "beijinho", percentual: 33 }, { tipo: "cajuzinho", percentual: 33 }]);
  assert.equal(d.tipo, "CALCULADO");
  assert.deepEqual(d.tipo === "CALCULADO" && d.distribuicao, [{ tipo: "brigadeiro", quantidade: 68 }, { tipo: "beijinho", quantidade: 66 }, { tipo: "cajuzinho", quantidade: 66 }]);
  assert.equal(calcularDoces(50, 4, undefined, [{ tipo: "a", percentual: 50 }, { tipo: "b", percentual: 40 }]).tipo, "DISTRIBUICAO_INVALIDA");
  assert.equal(calcularDoces(50, 4, undefined, [{ tipo: "a", quantidade: 100 }, { tipo: "b", quantidade: 90 }]).tipo, "DISTRIBUICAO_INVALIDA");
});

test("cálculo de refrigerante: mL inteiros, conversão exata, embalagem indivisível para cima com sobra", () => {
  const exato = calcularRefrigerantes(50, 400, 2000);
  assert.deepEqual([exato.totalMl, exato.embalagens, exato.sobraMl], [20000, 10, 0]);
  assert.match(exato.formula[0], /50 convidados × 400 mL = 20\.000 mL = 20 L/);
  const sobra = calcularRefrigerantes(45, 350, 2000);
  assert.deepEqual([sobra.totalMl, sobra.embalagens, sobra.sobraMl], [15750, 8, 250]);
  assert.match(sobra.formula.at(-1)!, /8 embalagens .*sobra de 250 mL/);
  assert.equal(litros(15750), "15,75 L");
  assert.equal(litros(20500), "20,5 L");
  assert.equal(calcularRefrigerantes(50, 400).embalagens, null);
});

test("contratação: extração da frase exata, ano nunca presumido, data impossível e horários conflitantes", () => {
  const p = extrairContratacao("crie uma festa do Felipe, pacote premium 50 convidados, beatriz 1 ano; tema unicórnio", null);
  // pacoteTexto: o trecho até a pontuação, que o Core confronta com o catálogo da empresa (fase 1d).
  assert.deepEqual(p, { cliente: "Felipe", pacote: "premium", pacoteTexto: "premium 50 convidados", pacoteResto: "beatriz 1 ano; tema unicórnio", pacoteRecusas: null, convidados: 50, aniversariante: "Beatriz", idade: 1, tema: "unicórnio" });
  assert.deepEqual(faltandoContratacao(p), ["data", "turno"]);
  const semAno = { ...p, ...extrairContratacao("dia 15/11", "data") };
  assert.deepEqual(faltandoContratacao(semAno), ["ano", "turno"]);
  assert.equal(extrairContratacao("2026", "ano").ano, 2026);
  assert.throws(() => validarContratacao({ ...p, data: "2026-09-31", turno: "noite" }), /31\/09\/2026 não existe/);
  assert.deepEqual(extrairContratacao("no almoço ou à noite", null).turnoConflito, true);
  assert.deepEqual(extrairContratacao("às 12h e às 19h", null).horarioConflito, ["12:00", "19:00"]);
  assert.equal(extrairContratacao("às 19h", null).horario, "19:00");
});
