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
