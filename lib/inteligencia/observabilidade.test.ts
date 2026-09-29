import assert from "node:assert/strict";
import test from "node:test";
import type { ModelUsage } from "./contratos.ts";
import { agregarMetricas } from "./metricas.ts";
import { VERSAO_POLITICA } from "./politica-v1.ts";
import { anotarOrquestracao, anotarSkill, anotarUsoModelo, novoRastreio, registrarRastreio, sanearRastreio, type RastreioInteligencia } from "./rastreio.ts";
import { VERSAO_REGISTRO } from "./registro-ferramentas.ts";

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const USUARIO = "aaaaaaaa-0000-4000-8000-000000000001";

/** Campos exigidos pelo Master Goal (nome da especificação → campo do trace). */
const MAPA_ESPECIFICACAO: Record<string, keyof RastreioInteligencia> = {
  traceId: "traceId", tenantId: "empresaId", establishmentId: "estabelecimentoId", userId: "usuarioId", capability: "capacidade",
  skill: "skills", jevClassifier: "classificadorJev", model: "modelo", provider: "provedor", tokensIn: "tokensEntrada", tokensOut: "tokensSaida",
  estimatedCost: "custoEstimadoMicros", latency: "duracaoMs", fallback: "fallback", toolProposal: "propostaAcao", humanGate: "humanGate",
  result: "resultado", errorCode: "codigo", policy: "politica", toolsRequested: "ferramentasSolicitadas", toolsExecuted: "ferramentasExecutadas",
};

test("Trace V1: todos os campos da especificação existem desde o nascimento, com versões dos contratos", () => {
  const r = novoRastreio("inteligencia.conversa", "req-1", "corr-1");
  for (const [especificacao, campo] of Object.entries(MAPA_ESPECIFICACAO)) assert.ok(campo in r, `${especificacao} → ${campo}`);
  assert.equal(r.traceId, "corr-1");
  assert.equal(novoRastreio("inteligencia.capacidade", "req-2", null).traceId, "req-2");
  assert.equal(r.estabelecimentoId, null);
  assert.equal(r.versaoRegistro, VERSAO_REGISTRO);
  assert.equal(r.versaoPolitica, VERSAO_POLITICA);
});

test("Trace V1: orquestração anota skills (proveniência) e a origem do julgamento JEV, sem texto", () => {
  const r = novoRastreio("inteligencia.conversa", "req");
  anotarOrquestracao(r, { versao: "d", passos: [{ tipo: "LEITURA", resultado: "resposta", duracaoMs: 3 }], parada: "LEITURA", chamadasModelo: 0, custoEstimadoMicros: null, julgamento: { origem: "COMBINADO", intent: "CONSULTA" }, skills: ["atendimento_familias@1.0.0#b045e8ea"] });
  anotarSkill(r, "atendimento_familias@1.0.0#b045e8ea");
  assert.deepEqual(r.skills, ["atendimento_familias@1.0.0#b045e8ea"]);
  assert.equal(r.classificadorJev, "COMBINADO");
});

test("Trace V1: saneamento — formato fechado, PII e segredos redigidos, UUIDs preservados", () => {
  const r = novoRastreio("inteligencia.conversa", "req", "corr") as RastreioInteligencia & Record<string, unknown>;
  r.empresaId = EMPRESA;
  r.usuarioId = USUARIO;
  r.codigo = "Cliente CPF 123.456.789-09";
  r.capacidade = "x".repeat(500);
  r.estado = "contato ana@example.com";
  r.causa = "INESPERADO";
  r.skills = ["postgresql://user:senha@host/db"];
  r.textoDoPedido = "me passa o telefone (11) 98765-4321";
  r.orquestracao = { versao: "d", passos: [{ tipo: "LEITURA", resultado: "R$ 8.500", duracaoMs: 1 }], parada: "LEITURA", chamadasModelo: 0, custoEstimadoMicros: null, julgamento: null, skills: [] };
  const s = sanearRastreio(r);
  assert.equal("textoDoPedido" in s, false);
  assert.equal(s.empresaId, EMPRESA);
  assert.equal(s.usuarioId, USUARIO);
  assert.equal(s.codigo, "[REDIGIDO]");
  assert.equal(s.estado, "[REDIGIDO]");
  assert.deepEqual(s.skills, ["[REDIGIDO]"]);
  assert.equal((s.capacidade as string).length, 160);
  assert.equal((s.orquestracao as { passos: Array<{ resultado: string }> }).passos[0].resultado, "[REDIGIDO]");
  const linhas: string[] = [];
  registrarRastreio(r, (l) => linhas.push(l));
  assert.doesNotMatch(linhas[0], /123\.456|ana@|98765|senha|R\$ 8/);
});

// ---------------------------------------------------------------- métricas

const linha = (extra: Partial<RastreioInteligencia>): RastreioInteligencia => ({ ...novoRastreio("inteligencia.conversa", "r"), ...extra });

test("Métricas: contagens, taxa de fallback e latência por percentil", () => {
  const m = agregarMetricas([
    linha({ capacidade: "atencao_hoje", politica: "PERMITIDO", duracaoMs: 100 }),
    linha({ capacidade: "atencao_hoje", politica: "PERMITIDO", duracaoMs: 200 }),
    linha({ capacidade: "resumir_festa", politica: "NEGADO_PAPEL", resultado: "negado", causa: "POLITICA", duracaoMs: 50 }),
    linha({ resultado: "fallback", fallback: true, causa: "TEMPO", duracaoMs: 5000 }),
    linha({ humanGate: "RASCUNHO", propostaAcao: "criar_pacote", duracaoMs: 300, skills: ["s@1#abc"] }),
  ]);
  assert.equal(m.pedidos, 5);
  assert.equal(m.porCapacidade.atencao_hoje, 2);
  assert.equal(m.porPolitica.NEGADO_PAPEL, 1);
  assert.equal(m.porCausa.TEMPO, 1);
  assert.equal(m.fallbacks, 1);
  assert.equal(m.taxaFallback, 0.2);
  assert.equal(m.propostasAcao, 1);
  assert.equal(m.porSkill["s@1#abc"], 1);
  assert.deepEqual(m.latenciaMs, { p50: 200, p95: 5000, max: 5000 });
});

test("Métricas: custo ou tokens desconhecidos nunca viram zero", () => {
  const conhecido = linha({ chamadasModelo: 1, tokensEntrada: 100, tokensSaida: 20, custoEstimadoMicros: 300 });
  assert.equal(agregarMetricas([conhecido, conhecido]).custoEstimadoMicros, 600);
  const m = agregarMetricas([conhecido, linha({ chamadasModelo: 1, tokensEntrada: null, tokensSaida: null, custoEstimadoMicros: null }), linha({})]);
  assert.equal(m.custoEstimadoMicros, null);
  assert.equal(m.custoDesconhecido, 1);
  assert.equal(m.tokensEntrada, null);
  assert.equal(m.chamadasModelo, 2);
});

test("Trace V1: uso de modelo com preço desconhecido fica null no trace (não zero)", () => {
  const r = novoRastreio("inteligencia.conversa", "req");
  const uso = (custo: number | null): ModelUsage => ({
    correlationId: "c", empresaId: EMPRESA, estabelecimentoId: null, capacidade: "copiloto_explicar", workload: "TEXTO_CURTO", tier: "ECONOMY", provedor: "openai",
    modelo: "m", tokensEntrada: 10, tokensSaida: 5, tokensCache: null, duracaoMs: 10, custoEstimadoMicros: custo, moeda: "USD", sucesso: true, erro: null, fallback: false, em: "",
  } as unknown as ModelUsage);
  anotarUsoModelo(r, [uso(10), uso(null)]);
  assert.equal(r.custoEstimadoMicros, null);
  assert.equal(r.tokensEntrada, 20);
});

// ---------------------------------------------------------------- A3 (auditoria): uso de modelo acumula no trace

const usoA3 = (extra: Partial<ModelUsage>): ModelUsage => ({
  correlationId: "c", empresaId: EMPRESA, estabelecimentoId: null, capacidade: "x", workload: "TEXTO_CURTO", tier: "ECONOMY", provedor: "OPENAI",
  modelo: "m", tokensEntrada: 100, tokensSaida: 10, tokensCache: null, duracaoMs: 50, custoEstimadoMicros: 300, moeda: "USD", sucesso: true, erro: null, fallback: false, em: "",
  ...extra,
} as unknown as ModelUsage);

test("A3: duas chamadas conhecidas em momentos diferentes SOMAM tokens, custo, chamadas e latência (nunca substituem)", () => {
  const r = novoRastreio("inteligencia.conversa", "req");
  anotarUsoModelo(r, [usoA3({})]);
  anotarUsoModelo(r, [usoA3({ tokensEntrada: 40, tokensSaida: 5, custoEstimadoMicros: 120, duracaoMs: 30, modelo: "m2" })]);
  assert.deepEqual([r.tokensEntrada, r.tokensSaida, r.tokensTotal, r.custoEstimadoMicros, r.custoConhecidoMicros, r.chamadasModelo, r.duracaoModeloMs, r.modelo],
    [140, 15, 155, 420, 420, 2, 80, "m2"]);
  assert.equal(r.chamadasCustoDesconhecido, 0);
});

test("A3: custo desconhecido nunca vira conhecido — primeira desconhecida + segunda conhecida, e o inverso", () => {
  for (const ordem of [[null, 200], [200, null]] as const) {
    const r = novoRastreio("inteligencia.conversa", "req");
    for (const custo of ordem) anotarUsoModelo(r, [usoA3({ custoEstimadoMicros: custo, moeda: custo === null ? null : "USD" })]);
    assert.equal(r.custoEstimadoMicros, null, JSON.stringify(ordem));
    assert.equal(r.chamadasCustoDesconhecido, 1);
    assert.equal(r.custoConhecidoMicros, 200, "subtotal conhecido preservado");
    assert.equal(r.tokensTotal, 220);
  }
  const moedas = novoRastreio("inteligencia.conversa", "req");
  anotarUsoModelo(moedas, [usoA3({ moeda: "USD" })]);
  anotarUsoModelo(moedas, [usoA3({ moeda: "BRL" })]);
  assert.equal(moedas.custoEstimadoMicros, null, "moedas diferentes nunca se somam");
  assert.deepEqual([moedas.custoConhecidoMicros, moedas.moedaCusto, moedas.chamadasCustoDesconhecido], [300, "USD", 1]);
});

test("A3: tokens desconhecidos (timeout/retry) tornam o total desconhecido até o fim do pedido", () => {
  const r = novoRastreio("inteligencia.conversa", "req");
  anotarUsoModelo(r, [usoA3({ tokensEntrada: null, tokensSaida: null, custoEstimadoMicros: null, moeda: null, sucesso: false, erro: "TIMEOUT" } as never), usoA3({})]);
  anotarUsoModelo(r, [usoA3({})]);
  assert.deepEqual([r.tokensEntrada, r.tokensTotal, r.chamadasTokensDesconhecidos, r.chamadasModelo], [null, null, 1, 3]);
});

test("A3: roteador real — primário falha, fallback responde, e uma segunda chamada: o trace soma as três", async () => {
  const { Circuito } = await import("./modelos/circuito.ts");
  const { criarProvedorFake, respostaFake } = await import("./modelos/fake.ts");
  const { criarRegistroUsoEmMemoria, orcamentoDoAmbiente } = await import("./modelos/orcamento.ts");
  const { RoteadorModelos, politicaDoAmbiente } = await import("./modelos/roteador.ts");
  const { ErroModelo } = await import("./modelos/tipos.ts");
  let primarioVivo = false;
  const primario = criarProvedorFake({ id: "OPENAI", roteiro: () => (primarioVivo ? respostaFake("{}", { entrada: 30, saida: 3 }) : new ErroModelo("HTTP_5XX", false)) });
  const secundario = criarProvedorFake({ id: "DEEPSEEK", roteiro: () => respostaFake("{}", { entrada: 70, saida: 7 }) });
  let n = 0;
  const roteador = new RoteadorModelos({
    politica: politicaDoAmbiente({ AI_PROVIDER_PRIMARY: "OPENAI", AI_PROVIDER_ECONOMY: "OPENAI", AI_MODEL_MAX_RETRIES: "0", AI_FALLBACK_ENABLED: "true" }),
    adaptadores: new Map([["OPENAI", primario as never], ["DEEPSEEK", secundario as never]]),
    precos: { moeda: "USD", modelos: { "OPENAI:fake-economy": { entrada: 1, saida: 1 }, "DEEPSEEK:fake-economy": { entrada: 1, saida: 1 } } },
    orcamento: orcamentoDoAmbiente({ AI_BUDGET_JSON: JSON.stringify({ porEmpresa: { tokensDiario: 1_000_000 } }) }),
    registro: criarRegistroUsoEmMemoria(), circuito: new Circuito(), agora: () => new Date("2026-09-29T12:00:00Z"), relogio: () => performance.now(),
    novoId: () => `${String(++n).padStart(8, "0")}-0000-4000-8000-000000000000`,
  });
  const pedido = { workload: "TEXTO_CURTO" as const, mensagens: [{ papel: "user" as const, conteudo: "x" }], esquema: { nome: "x", schema: {} }, maxTokensSaida: 10, validar: (t: string) => JSON.parse(t) };
  const alvo = { empresaId: EMPRESA, capacidade: "x", correlationId: "c", hoje: "2026-09-29" };
  const r = novoRastreio("inteligencia.conversa", "req");
  anotarUsoModelo(r, (await roteador.executar(pedido, alvo)).usos);
  primarioVivo = true;
  anotarUsoModelo(r, (await roteador.executar(pedido, alvo)).usos);
  assert.equal(secundario.chamadas.length, 1, "o fallback respondeu a primeira");
  assert.equal(r.chamadasModelo, 3, "falha do primário + fallback + segunda chamada");
  assert.equal(r.fallbackProvedor, true);
  // A falha HTTP 5XX do primário não tem uso conhecido: totais ficam desconhecidos (null), nunca "conhecidos" pela
  // metade; o subtotal conhecido soma as DUAS respostas (fallback 70+7 e primário 30+3 = 110), não só a última.
  assert.deepEqual(
    { tokensTotal: r.tokensTotal, custo: r.custoEstimadoMicros, conhecido: r.custoConhecidoMicros, custoDesconhecido: r.chamadasCustoDesconhecido, tokensDesconhecidos: r.chamadasTokensDesconhecidos },
    { tokensTotal: null, custo: null, conhecido: 110, custoDesconhecido: 1, tokensDesconhecidos: 1 },
  );
});
