import assert from "node:assert/strict";
import test from "node:test";
import type { IdProvedor } from "../contratos.ts";
import { Circuito } from "./circuito.ts";
import { criarProvedorFake, respostaFake } from "./fake.ts";
import { PERFIL_DEEPSEEK, PERFIL_OPENAI, criarAdaptadorOpenAICompativel } from "./openai-compativel.ts";
import { ESTIMATIVA_PADRAO, TTL_RESERVA_MS, criarRegistroUsoEmMemoria, estimarTokensEntrada, orcamentoDoAmbiente } from "./orcamento.ts";
import { custoEstimado, tabelaDoAmbiente } from "./precos.ts";
import { RoteadorModelos, criarAdaptadores, politicaDoAmbiente, type DependenciasRoteador } from "./roteador.ts";
import { ErroModelo, type AdaptadorProvedor, type PedidoModelo } from "./tipos.ts";

const CHAVE = "sk-teste-0000000000000000000000000000";
const alvo = { empresaId: "11111111-1111-4111-8111-111111111111", capacidade: "criar_pacote", correlationId: "corr-1", hoje: "2026-09-28" };

function pedido(workload: PedidoModelo<unknown>["workload"] = "CLASSIFICAR_INTENCAO"): PedidoModelo<{ ok: boolean }> {
  return {
    workload,
    mensagens: [{ papel: "system", conteudo: "sistema" }, { papel: "user", conteudo: "pergunta" }],
    esquema: { nome: "saida", schema: { type: "object" } },
    maxTokensSaida: 50,
    validar: (texto) => {
      const valor = JSON.parse(texto) as { ok?: unknown };
      if (valor.ok !== true) throw new Error("inválido");
      return { ok: true };
    },
  };
}

function roteador(adaptadores: AdaptadorProvedor[], extra: Partial<DependenciasRoteador> = {}, env: Record<string, string> = {}) {
  const registro = criarRegistroUsoEmMemoria();
  let t = 0;
  let id = 0;
  const deps: DependenciasRoteador = {
    politica: politicaDoAmbiente({ AI_PROVIDER_PRIMARY: "OPENAI", AI_PROVIDER_ECONOMY: "DEEPSEEK", AI_MODEL_MAX_RETRIES: "1", AI_FALLBACK_ENABLED: "true", ...env }),
    adaptadores: new Map(adaptadores.map((a) => [a.id, a] as [IdProvedor, AdaptadorProvedor])),
    precos: null,
    // B1: toda chamada precisa de teto aplicável; os testes que medem o orçamento passam o seu.
    orcamento: orcamentoDoAmbiente({ AI_BUDGET_JSON: JSON.stringify({ porEmpresa: { tokensDiario: 10_000_000 } }) }),
    registro,
    circuito: new Circuito(),
    agora: () => new Date("2026-09-28T15:00:00Z"),
    relogio: () => (t += 5),
    novoId: () => `${String(++id).padStart(8, "0")}-0000-4000-8000-00000000000r`,
    ...extra,
  };
  return { r: new RoteadorModelos(deps), registro };
}

test("provedor sem chave fica indisponível de forma segura, sem chamar a rede", async () => {
  let chamadas = 0;
  const buscar = async () => { chamadas += 1; return new Response("{}"); };
  const adaptadores = criarAdaptadores({ AI_OPENAI_MODEL_ECONOMY: "modelo-x" }, buscar);
  const { r } = roteador([...adaptadores.values()]);
  const resultado = await r.executar(pedido(), alvo);
  assert.deepEqual(resultado, {
    ok: false, causa: "SEM_CHAVE", usos: [],
    recusa: { causa: "SEM_CHAVE", workload: "CLASSIFICAR_INTENCAO", capacidade: "criar_pacote", motivo: null, escopo: null, periodo: null, tokensReserva: null },
  });
  assert.equal(chamadas, 0);
  assert.equal(r.disponivelPara("CLASSIFICAR_INTENCAO"), false);
});

test("extração disponível mesmo sem modelo de intenção: cada workload confere o próprio tier", () => {
  const buscar = async () => { throw new Error("não deveria chamar"); };
  const adaptadores = criarAdaptadores({ OPENAI_API_KEY: CHAVE, AI_OPENAI_MODEL_STANDARD: "modelo-padrao" }, buscar);
  const { r } = roteador([...adaptadores.values()], {}, { AI_PROVIDER_ECONOMY: "" });
  assert.equal(r.disponivelPara("CLASSIFICAR_INTENCAO"), false, "sem modelo ECONOMY a conversa fica só nas regras");
  assert.equal(r.disponivelPara("EXTRACAO_CONTRATO"), true);
});

test("sem modelo configurado para o tier o provedor não é usado: nenhum nome de modelo é inventado", async () => {
  const buscar = async () => { throw new Error("não deveria chamar"); };
  const adaptador = criarAdaptadorOpenAICompativel(PERFIL_OPENAI, { OPENAI_API_KEY: CHAVE }, buscar);
  assert.equal(adaptador.disponivel(), true);
  assert.equal(adaptador.modeloPara("ECONOMY"), null);
  const { r } = roteador([adaptador], {}, { AI_PROVIDER_ECONOMY: "OPENAI" });
  const resultado = await r.executar(pedido(), alvo);
  assert.equal(resultado.ok, false);
  assert.equal((resultado as { causa: string }).causa, "SEM_MODELO");
});

test("OpenAI: HTTPS, bearer, json_schema estrito, sem tools; a chave nunca aparece no uso ou no erro", async () => {
  const pedidos: Array<{ url: string; init: RequestInit }> = [];
  const buscar = async (url: string, init: RequestInit) => {
    pedidos.push({ url, init });
    return new Response(JSON.stringify({ model: "modelo-eco", choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 120, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 20 } } }));
  };
  const adaptador = criarAdaptadorOpenAICompativel(PERFIL_OPENAI, { OPENAI_API_KEY: CHAVE, AI_OPENAI_MODEL_ECONOMY: "modelo-eco" }, buscar);
  const { r, registro } = roteador([adaptador], {}, { AI_PROVIDER_ECONOMY: "OPENAI" });
  const resultado = await r.executar(pedido(), alvo);
  assert.equal(resultado.ok, true);
  assert.equal(pedidos[0].url, "https://api.openai.com/v1/chat/completions");
  const corpo = JSON.parse(String(pedidos[0].init.body));
  assert.equal(corpo.model, "modelo-eco");
  assert.equal(corpo.response_format.type, "json_schema");
  assert.equal(corpo.response_format.json_schema.strict, true);
  assert.equal("tools" in corpo || "functions" in corpo, false);
  assert.equal((pedidos[0].init.headers as Record<string, string>).authorization, `Bearer ${CHAVE}`);
  assert.deepEqual([registro.usos[0].tokensEntrada, registro.usos[0].tokensSaida, registro.usos[0].tokensCache], [120, 8, 20]);
  assert.equal(JSON.stringify(registro.usos).includes(CHAVE), false);
  assert.equal(JSON.stringify(resultado).includes(CHAVE), false);
});

test("base URL sem HTTPS é recusada (a chave não trafega em claro)", () => {
  const adaptador = criarAdaptadorOpenAICompativel(PERFIL_OPENAI, { OPENAI_API_KEY: CHAVE, AI_OPENAI_BASE_URL: "http://proxy.local/v1", AI_OPENAI_MODEL_ECONOMY: "m" }, async () => new Response("{}"));
  assert.equal(adaptador.disponivel(), false);
});

test("DeepSeek: formato json_object e max_tokens; cache via prompt_cache_hit_tokens", async () => {
  let corpo: Record<string, unknown> = {};
  const buscar = async (_url: string, init: RequestInit) => {
    corpo = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 50, completion_tokens: 5, prompt_cache_hit_tokens: 10 } }));
  };
  const adaptador = criarAdaptadorOpenAICompativel(PERFIL_DEEPSEEK, { DEEPSEEK_API_KEY: CHAVE, AI_DEEPSEEK_MODEL_ECONOMY: "deepseek-eco" }, buscar);
  const { r, registro } = roteador([adaptador]);
  const resultado = await r.executar(pedido(), alvo);
  assert.equal(resultado.ok, true);
  assert.deepEqual(corpo.response_format, { type: "json_object" });
  assert.equal(corpo.max_tokens, 50);
  assert.equal(registro.usos[0].tokensCache, 10);
  assert.equal(adaptador.aceitaImagens(), false);
});

test("timeout: retry limitado no mesmo provedor e depois fallback permitido pela política", async () => {
  const lento = criarProvedorFake({ id: "DEEPSEEK", roteiro: () => new ErroModelo("TIMEOUT", true) });
  const bom = criarProvedorFake({ id: "OPENAI", roteiro: () => respostaFake('{"ok":true}') });
  const { r, registro } = roteador([lento, bom]);
  const resultado = await r.executar(pedido(), alvo);
  assert.equal(resultado.ok, true);
  assert.equal(lento.chamadas.length, 2, "1 tentativa + 1 retry");
  assert.equal(bom.chamadas.length, 1);
  assert.deepEqual(registro.usos.map((u) => [u.provedor, u.erro, u.fallback]), [["DEEPSEEK", "TIMEOUT", false], ["DEEPSEEK", "TIMEOUT", false], ["OPENAI", null, true]]);
});

test("timeout real do AbortController encerra a chamada pendente", async () => {
  const travado: AdaptadorProvedor = {
    id: "OPENAI",
    modeloPara: () => "m",
    disponivel: () => true,
    aceitaImagens: () => false,
    gerar: (_p, _m, sinal) => new Promise((_ok, falha) => sinal.addEventListener("abort", () => falha(new ErroModelo("TIMEOUT", true)))),
  };
  const { r } = roteador([travado], {}, { AI_MODEL_TIMEOUT_MS: "1000", AI_MODEL_MAX_RETRIES: "0", AI_PROVIDER_ECONOMY: "OPENAI" });
  const inicio = Date.now();
  const resultado = await r.executar(pedido(), alvo);
  assert.equal(resultado.ok, false);
  assert.equal((resultado as { causa: string }).causa, "TIMEOUT");
  assert.ok(Date.now() - inicio < 5000);
});

test("extração de contrato não troca de provedor sozinha (documento não vai a um segundo provedor)", async () => {
  const falho = criarProvedorFake({ id: "OPENAI", roteiro: () => new ErroModelo("HTTP_5XX", true) });
  const outro = criarProvedorFake({ id: "DEEPSEEK", roteiro: () => respostaFake('{"ok":true}') });
  const { r } = roteador([falho, outro]);
  const resultado = await r.executar(pedido("EXTRACAO_CONTRATO"), alvo);
  assert.equal(resultado.ok, false);
  assert.equal(outro.chamadas.length, 0);
  assert.equal(falho.chamadas.length, 2);
});

test("erro 4xx não é repetido; saída inválida é recusada e o uso (tokens gastos) é registrado", async () => {
  const quatrocentos = criarProvedorFake({ id: "DEEPSEEK", roteiro: () => new ErroModelo("HTTP_4XX", false) });
  const invalido = criarProvedorFake({ id: "OPENAI", roteiro: () => respostaFake('{"ok":"talvez"}', { entrada: 30, saida: 7 }) });
  const { r, registro } = roteador([quatrocentos, invalido]);
  const resultado = await r.executar(pedido(), alvo);
  assert.equal(quatrocentos.chamadas.length, 1);
  assert.equal(resultado.ok, false);
  assert.equal((resultado as { causa: string }).causa, "RESPOSTA_INVALIDA");
  const ultimo = registro.usos.at(-1)!;
  assert.deepEqual([ultimo.erro, ultimo.tokensEntrada, ultimo.tokensSaida, ultimo.sucesso], ["RESPOSTA_INVALIDA", 30, 7, false]);
});

test("pricing configurável: custo em micro-unidades; sem preço o custo é desconhecido (null), nunca zero", async () => {
  const precos = tabelaDoAmbiente({ AI_PRICING_JSON: JSON.stringify({ moeda: "USD", modelos: { "OPENAI:modelo-eco": { entrada: 0.5, saida: 2, cache: 0.25 } } }) });
  assert.ok(precos);
  assert.deepEqual(custoEstimado(precos, "OPENAI", "modelo-eco", { entrada: 1000, saida: 100, cache: 200 }), { micros: 800 * 0.5 + 200 * 0.25 + 100 * 2, moeda: "USD" });
  assert.equal(custoEstimado(precos, "OPENAI", "outro", { entrada: 1, saida: 1, cache: null }), null);
  assert.equal(tabelaDoAmbiente({ AI_PRICING_JSON: "{quebrado" }), null);
  assert.equal(tabelaDoAmbiente({ AI_PRICING_JSON: JSON.stringify({ moeda: "USD", modelos: { "OPENAI:m": { entrada: -1, saida: 0 } } }) }), null);

  const fake = criarProvedorFake({ id: "OPENAI", modelos: { ECONOMY: "modelo-eco" }, roteiro: () => respostaFake('{"ok":true}', { entrada: 1000, saida: 100 }) });
  const { r, registro } = roteador([fake], { precos }, { AI_PROVIDER_ECONOMY: "OPENAI" });
  await r.executar(pedido(), alvo);
  assert.equal(registro.usos[0].custoEstimadoMicros, 1000 * 0.5 + 100 * 2);
  assert.equal(registro.usos[0].moeda, "USD");
});

test("orçamento: excedido ou inválido bloqueia a chamada antes da rede (fail-safe)", async () => {
  const fake = criarProvedorFake({ id: "OPENAI", modelos: { ECONOMY: "m" }, roteiro: () => respostaFake('{"ok":true}', { entrada: 600, saida: 0 }) });
  const orcamento = orcamentoDoAmbiente({ AI_BUDGET_JSON: JSON.stringify({ porEmpresa: { tokensDiario: 1000 }, estimativa: { overheadTokens: 64 } }) });
  const { r, registro } = roteador([fake], { orcamento }, { AI_PROVIDER_ECONOMY: "OPENAI" });
  assert.equal((await r.executar(pedido(), alvo)).ok, true);
  assert.equal((await r.executar(pedido(), alvo)).ok, true);
  const terceira = await r.executar(pedido(), alvo);
  assert.deepEqual([terceira.ok, (terceira as { causa: string }).causa], [false, "ORCAMENTO"]);
  assert.equal(fake.chamadas.length, 2);
  assert.equal(registro.usos.length, 2);

  // Outra empresa tem o próprio orçamento.
  assert.equal((await r.executar(pedido(), { ...alvo, empresaId: "22222222-2222-4222-8222-222222222222" })).ok, true);

  assert.equal(orcamentoDoAmbiente({ AI_BUDGET_JSON: "{" }), "INVALIDO");
  const bloqueado = roteador([fake], { orcamento: "INVALIDO" }, { AI_PROVIDER_ECONOMY: "OPENAI" });
  assert.equal((await bloqueado.r.executar(pedido(), alvo)).ok, false);

  // Limite de custo sem preço configurado não pode ser medido: recusa.
  const semPreco = roteador([fake], { orcamento: orcamentoDoAmbiente({ AI_BUDGET_JSON: JSON.stringify({ porEmpresa: { custoDiario: 1 } }) }) }, { AI_PROVIDER_ECONOMY: "OPENAI" });
  assert.equal((await semPreco.r.executar(pedido(), alvo)).ok, false);
});

test("A5: ausência ou ambiguidade de configuração nunca libera nada (orçamento, fallback, flags)", async () => {
  // Orçamento ausente = bloqueado, como inválido: sem limite nunca é padrão do ambiente.
  for (const bruto of [undefined, "", "   "]) assert.equal(orcamentoDoAmbiente({ AI_BUDGET_JSON: bruto }), "AUSENTE");
  const fake = criarProvedorFake({ id: "OPENAI", modelos: { ECONOMY: "m" }, roteiro: () => respostaFake('{"ok":true}') });
  const semOrcamento = roteador([fake], { orcamento: orcamentoDoAmbiente({}) }, { AI_PROVIDER_ECONOMY: "OPENAI" });
  const r = await semOrcamento.r.executar(pedido(), alvo);
  assert.deepEqual([r.ok, (r as { causa: string }).causa], [false, "ORCAMENTO"]);
  assert.equal(fake.chamadas.length, 0, "nenhuma chamada de rede sem orçamento");
  // Fallback de provedor e flags: só o valor exato "true" liga.
  const { envioDocumentoExternoAutorizado, grupoAtivo, grupoAtivoParaEmpresa, inteligenciaAtiva, jevAtivo } = await import("../flags.ts");
  for (const valor of [undefined, "", "TRUE", "True", "1", "yes", "sim", " true", "true "]) {
    const env = { INTELIGENCIA_ENABLED: valor, AI_READ_ENABLED: valor, AI_ADMIN_ACTIONS_ENABLED: valor, AI_CONTRACT_IMPORT_ENABLED: valor, AI_DOCUMENT_EXTERNAL_PROVIDER_ALLOWED: valor, AI_JEV_ENABLED: valor, AI_FALLBACK_ENABLED: valor };
    assert.equal(inteligenciaAtiva(env), false, `chave-mestra: ${valor}`);
    for (const grupo of ["READ", "ADMIN_ACTIONS", "CONTRACT_IMPORT"] as const) assert.equal(grupoAtivo(env, grupo), false, `${grupo}: ${valor}`);
    assert.equal(envioDocumentoExternoAutorizado(env), false);
    assert.equal(jevAtivo(env), false);
    assert.equal(Object.values(politicaDoAmbiente(env).fallback).some(Boolean), false);
  }
  // Allowlist definida e inválida ⇒ nenhuma empresa (não "todas").
  const ligado = { INTELIGENCIA_ENABLED: "true", AI_ADMIN_ACTIONS_ENABLED: "true" };
  assert.equal(grupoAtivoParaEmpresa({ ...ligado, AI_TENANT_ALLOWLIST: "nao-e-uuid" }, "ADMIN_ACTIONS", alvo.empresaId), false);
  assert.equal(grupoAtivoParaEmpresa({ ...ligado, AI_TENANT_ALLOWLIST: `${alvo.empresaId},x` }, "ADMIN_ACTIONS", alvo.empresaId), false);
});

test("B1: sem teto aplicável à operação atual, o modelo NÃO é chamado (8 regressões)", async () => {
  const casos: Array<[string, string | undefined, boolean]> = [
    ["1. env ausente", undefined, false],
    ["2. JSON inválido", "{", false],
    ["3. null", "null", false],
    ["4. {}", "{}", false],
    ["5. porEmpresa vazio", JSON.stringify({ porEmpresa: {} }), false],
    ["5b. capacidade atual com objeto vazio", JSON.stringify({ porCapacidade: { [alvo.capacidade]: {} } }), false],
    ["6. limite só de outra capacidade", JSON.stringify({ porCapacidade: { outra_coisa: { tokensDiario: 1_000_000 } } }), false],
    ["7. limite válido da capacidade atual", JSON.stringify({ porCapacidade: { [alvo.capacidade]: { tokensDiario: 1_000_000 } } }), true],
    ["8. empresa + capacidade", JSON.stringify({ porEmpresa: { tokensMensal: 5_000_000 }, porCapacidade: { [alvo.capacidade]: { tokensDiario: 1_000_000 } } }), true],
  ];
  for (const [nome, bruto, chama] of casos) {
    const fake = criarProvedorFake({ id: "OPENAI", modelos: { ECONOMY: "m" }, roteiro: () => respostaFake('{"ok":true}', { entrada: 10, saida: 2 }) });
    const { r } = roteador([fake], { orcamento: orcamentoDoAmbiente({ AI_BUDGET_JSON: bruto }) }, { AI_PROVIDER_ECONOMY: "OPENAI" });
    const resultado = await r.executar(pedido(), alvo);
    assert.equal(resultado.ok, chama, nome);
    assert.equal(fake.chamadas.length, chama ? 1 : 0, `${nome}: chamadas de rede`);
    if (!chama) assert.equal((resultado as { causa: string }).causa, "ORCAMENTO", nome);
  }
  // 8 (cont.): na combinação, o teto mais restritivo aplicável vale — o da capacidade estoura antes do da empresa.
  const fake = criarProvedorFake({ id: "OPENAI", modelos: { ECONOMY: "m" }, roteiro: () => respostaFake('{"ok":true}', { entrada: 600, saida: 0 }) });
  const combinado = orcamentoDoAmbiente({ AI_BUDGET_JSON: JSON.stringify({ porEmpresa: { tokensDiario: 1_000_000 }, porCapacidade: { [alvo.capacidade]: { tokensDiario: 1000 } }, estimativa: { overheadTokens: 64 } }) });
  const { r } = roteador([fake], { orcamento: combinado }, { AI_PROVIDER_ECONOMY: "OPENAI" });
  assert.equal((await r.executar(pedido(), alvo)).ok, true);
  assert.equal((await r.executar(pedido(), alvo)).ok, true);
  assert.equal((await r.executar(pedido(), alvo)).ok, false, "teto da capacidade (1200 usados + reserva > 1000)");
  assert.equal((await r.executar(pedido(), { ...alvo, capacidade: "outra_capacidade" })).ok, true, "outra capacidade usa só o teto da empresa");
  // Teto de custo sem preço conhecido não pode ser medido: não chama (preço é necessário ao teto aplicável).
  const semPreco = criarProvedorFake({ id: "OPENAI", modelos: { ECONOMY: "m" }, roteiro: () => respostaFake('{"ok":true}') });
  const custo = roteador([semPreco], { orcamento: orcamentoDoAmbiente({ AI_BUDGET_JSON: JSON.stringify({ moeda: "USD", porCapacidade: { [alvo.capacidade]: { custoDiario: 1 } } }) }) }, { AI_PROVIDER_ECONOMY: "OPENAI" });
  assert.equal((await custo.r.executar(pedido(), alvo)).ok, false);
  assert.equal(semPreco.chamadas.length, 0);
});

test("circuit breaker abre após falhas seguidas e deixa uma tentativa depois da janela", async () => {
  const circuito = new Circuito(3, 1000);
  assert.equal(circuito.permite("OPENAI", 0), true);
  for (let i = 0; i < 3; i += 1) circuito.falha("OPENAI", 10);
  assert.equal(circuito.permite("OPENAI", 500), false);
  assert.equal(circuito.permite("OPENAI", 1100), true);
  assert.equal(circuito.permite("OPENAI", 1100), false, "meio-aberto: só uma tentativa");
  circuito.sucesso("OPENAI");
  assert.equal(circuito.permite("OPENAI", 1200), true);

  const falho = criarProvedorFake({ id: "OPENAI", roteiro: () => new ErroModelo("HTTP_5XX", true) });
  const { r } = roteador([falho], { circuito: new Circuito(2, 60_000) }, { AI_PROVIDER_ECONOMY: "OPENAI", AI_MODEL_MAX_RETRIES: "2" });
  const resultado = await r.executar(pedido(), alvo);
  assert.equal(falho.chamadas.length, 2);
  assert.equal((resultado as { causa: string }).causa, "CIRCUITO_ABERTO");
});

test("política configurável por workload; retries e timeout limitados; fallback pode ser desligado", () => {
  const p = politicaDoAmbiente({ AI_PROVIDER_PRIMARY: "DEEPSEEK", AI_WORKLOAD_TIERS: JSON.stringify({ SUMARIZACAO: "ECONOMY" }), AI_MODEL_MAX_RETRIES: "50", AI_MODEL_TIMEOUT_MS: "5", AI_FALLBACK_ENABLED: "false" });
  assert.equal(p.primario, "DEEPSEEK");
  assert.equal(p.economico, null);
  assert.equal(p.tiers.SUMARIZACAO, "ECONOMY");
  assert.equal(p.tiers.REVISAO_COMPLEXA, "ADVANCED");
  assert.equal(p.tentativasExtras, 1);
  assert.equal(p.timeoutMs, 20_000);
  assert.equal(Object.values(p.fallback).some(Boolean), false);
  for (const valor of [undefined, "", "TRUE", "1", "sim", "yes"]) {
    assert.equal(Object.values(politicaDoAmbiente({ AI_PROVIDER_PRIMARY: "OPENAI", AI_FALLBACK_ENABLED: valor }).fallback).some(Boolean), false, `fail-closed: ${valor}`);
  }
  const ligado = politicaDoAmbiente({ AI_PROVIDER_PRIMARY: "OPENAI", AI_FALLBACK_ENABLED: "true" }).fallback;
  assert.equal(Object.values(ligado).some(Boolean), true);
  assert.equal(ligado.EXTRACAO_CONTRATO, false, "extração de contrato nunca cai para outro provedor");
  assert.equal(politicaDoAmbiente({ AI_PROVIDER_PRIMARY: "FAKE" }).primario, null, "FAKE nunca vem do ambiente");
});

// ---------------------------------------------------------------- H6: reserva → chamada → reconciliação

const ORCAMENTO_300 = () => orcamentoDoAmbiente({ AI_BUDGET_JSON: JSON.stringify({ porEmpresa: { tokensDiario: 300 }, estimativa: { overheadTokens: 64 } }) });

test("H6: duas chamadas simultâneas não passam do orçamento reservado (reserva antes da rede)", async () => {
  let liberar: () => void = () => {};
  const segura = new Promise<void>((ok) => { liberar = ok; });
  const fake = criarProvedorFake({ id: "OPENAI", modelos: { ECONOMY: "m" }, roteiro: async () => { await segura; return respostaFake('{"ok":true}', { entrada: 100, saida: 10 }); } });
  const { r, registro } = roteador([fake], { orcamento: ORCAMENTO_300() }, { AI_PROVIDER_ECONOMY: "OPENAI", AI_MODEL_MAX_RETRIES: "0" });
  // Cada reserva é o teto estimado (entrada estimada + 50 de saída ≈ 161): só uma cabe em 300.
  const primeira = r.executar(pedido(), alvo);
  const segunda = r.executar(pedido(), alvo);
  await new Promise((ok) => setImmediate(ok));
  liberar();
  const resultados = await Promise.all([primeira, segunda]);
  assert.deepEqual(resultados.map((x) => x.ok).sort(), [false, true]);
  assert.equal(resultados.find((x) => !x.ok && x.causa === "ORCAMENTO") !== undefined, true);
  assert.equal(fake.chamadas.length, 1, "a segunda chamada nunca chegou ao provedor");
  assert.deepEqual([...registro.reservas.values()].map((x) => x.estado), ["RECONCILIADA"]);
});

test("H6: provedor sem usage ⇒ USO DESCONHECIDO: tokens null (nunca zero) e a reserva continua contando", async () => {
  const fake = criarProvedorFake({ id: "OPENAI", modelos: { ECONOMY: "m" }, roteiro: () => respostaFake('{"ok":true}', { entrada: null, saida: null }) });
  const { r, registro } = roteador([fake], { orcamento: ORCAMENTO_300() }, { AI_PROVIDER_ECONOMY: "OPENAI" });
  assert.equal((await r.executar(pedido(), alvo)).ok, true);
  assert.deepEqual([registro.usos[0].tokensEntrada, registro.usos[0].tokensSaida], [null, null]);
  assert.deepEqual([...registro.reservas.values()].map((x) => x.estado), ["USO_DESCONHECIDO"]);
  // A reserva desconhecida (≈161) ainda conta: a próxima (≈161) não cabe em 300.
  const segunda = await r.executar(pedido(), alvo);
  assert.deepEqual([segunda.ok, (segunda as { causa: string }).causa], [false, "ORCAMENTO"]);
  assert.equal(fake.chamadas.length, 1);
});

test("H6: timeout mantém a reserva como consumida; recusa 4xx (antes do processamento) libera", async () => {
  const lento = criarProvedorFake({ id: "OPENAI", modelos: { ECONOMY: "m" }, roteiro: () => new ErroModelo("TIMEOUT", false) });
  const a = roteador([lento], { orcamento: ORCAMENTO_300() }, { AI_PROVIDER_ECONOMY: "OPENAI" });
  await a.r.executar(pedido(), alvo);
  assert.deepEqual([...a.registro.reservas.values()].map((x) => x.estado), ["USO_DESCONHECIDO"]);
  assert.equal(a.registro.usos[0].tokensEntrada, null);

  const recusa = criarProvedorFake({ id: "OPENAI", modelos: { ECONOMY: "m" }, roteiro: () => new ErroModelo("HTTP_4XX", false) });
  const b = roteador([recusa], { orcamento: ORCAMENTO_300() }, { AI_PROVIDER_ECONOMY: "OPENAI" });
  await b.r.executar(pedido(), alvo);
  await b.r.executar(pedido(), alvo);
  assert.equal(recusa.chamadas.length, 2, "reserva liberada: a segunda tentativa cabe no orçamento");
  assert.deepEqual([...b.registro.reservas.values()].map((x) => x.estado), ["LIBERADA", "LIBERADA"]);
  assert.deepEqual([b.registro.usos[0].tokensEntrada, b.registro.usos[0].tokensSaida], [0, 0]);
});

test("H6: falha ao persistir uso não é silenciosa: alerta sem PII e a reserva aberta segue contando", async () => {
  const fake = criarProvedorFake({ id: "OPENAI", modelos: { ECONOMY: "m" }, roteiro: () => respostaFake('{"ok":true}', { entrada: 10, saida: 2 }) });
  const registro = criarRegistroUsoEmMemoria();
  registro.reconciliar = async () => { throw new Error("banco fora"); };
  const alertas: unknown[] = [];
  const { r } = roteador([fake], { orcamento: ORCAMENTO_300(), registro, alertar: (a) => alertas.push(a) }, { AI_PROVIDER_ECONOMY: "OPENAI" });
  const resultado = await r.executar(pedido(), alvo);
  assert.equal(resultado.ok, true, "a resposta obtida não é perdida");
  assert.deepEqual(resultado.alertas, ["USO_NAO_REGISTRADO"]);
  assert.deepEqual(alertas, [{ codigo: "USO_NAO_REGISTRADO", empresaId: alvo.empresaId, correlationId: alvo.correlationId }]);
  assert.deepEqual([...registro.reservas.values()].map((x) => x.estado), ["ABERTA"], "reserva não reconciliada continua contando (fail closed)");
});

test("H6: moedas nunca se somam; limite de custo exige a moeda do orçamento igual à da tabela de preços", async () => {
  const precos = tabelaDoAmbiente({ AI_PRICING_JSON: JSON.stringify({ moeda: "USD", modelos: { "OPENAI:m": { entrada: 1, saida: 1 } } }) });
  const fake = criarProvedorFake({ id: "OPENAI", modelos: { ECONOMY: "m" }, roteiro: () => respostaFake('{"ok":true}', { entrada: 10, saida: 2 }) });
  const semMoeda = roteador([fake], { precos, orcamento: orcamentoDoAmbiente({ AI_BUDGET_JSON: JSON.stringify({ porEmpresa: { custoDiario: 1 } }) }) }, { AI_PROVIDER_ECONOMY: "OPENAI" });
  assert.equal((await semMoeda.r.executar(pedido(), alvo)).ok, false, "limite de custo sem moeda: recusa");
  const outraMoeda = roteador([fake], { precos, orcamento: orcamentoDoAmbiente({ AI_BUDGET_JSON: JSON.stringify({ moeda: "BRL", porEmpresa: { custoDiario: 1 } }) }) }, { AI_PROVIDER_ECONOMY: "OPENAI" });
  assert.equal((await outraMoeda.r.executar(pedido(), alvo)).ok, false, "orçamento em BRL com preço em USD: recusa");
  const mesma = roteador([fake], { precos, orcamento: orcamentoDoAmbiente({ AI_BUDGET_JSON: JSON.stringify({ moeda: "USD", porEmpresa: { custoDiario: 1 } }) }) }, { AI_PROVIDER_ECONOMY: "OPENAI" });
  assert.equal((await mesma.r.executar(pedido(), alvo)).ok, true);
  // Uso anterior em outra moeda no período: custo desconhecido ⇒ recusa.
  mesma.registro.usos.push({ ...mesma.registro.usos[0], moeda: "EUR", custoEstimadoMicros: 1 });
  assert.equal((await mesma.r.executar(pedido(), alvo)).ok, false);
});

// ---------------------------------------------------------------- A5 (H6): período fixo, estimativa, órfãs

/** Chamada que começa às 23:59:59 do dia 30/09 (São Paulo) e termina depois da meia-noite. */
function viraDaMeiaNoite(alvoHoje: string, fimIso: string) {
  let agora = new Date("2026-10-01T02:59:59.000Z"); // 23:59:59 de 30/09 em São Paulo
  const fake = criarProvedorFake({ id: "OPENAI", modelos: { ECONOMY: "m" }, roteiro: () => { agora = new Date(fimIso); return respostaFake('{"ok":true}', { entrada: 100, saida: 10 }); } });
  const orcamento = orcamentoDoAmbiente({ AI_BUDGET_JSON: JSON.stringify({ porEmpresa: { tokensDiario: 100_000, tokensMensal: 1_000_000 } }) });
  const { r, registro } = roteador([fake], { orcamento, agora: () => agora }, { AI_PROVIDER_ECONOMY: "OPENAI" });
  return { exec: () => r.executar(pedido(), { ...alvo, hoje: alvoHoje }), registro };
}

test("A5: virada DIÁRIA e MENSAL — reserva em 30/09 23:59:59, reconciliação em 01/10: consumo fica em 30/09 e em setembro", async () => {
  const v = viraDaMeiaNoite("2026-09-30", "2026-10-01T03:00:05.000Z");
  assert.equal((await v.exec()).ok, true);
  const [reserva] = [...v.registro.reservas.values()];
  assert.deepEqual(reserva.periodos, { dia: "2026-09-30", mes: "2026-09" });
  assert.equal(reserva.estado, "RECONCILIADA");
  assert.deepEqual(v.registro.usos[0].periodos, { dia: "2026-09-30", mes: "2026-09" }, "o uso herda o período da reserva, não o horário final");
  assert.equal(v.registro.usos[0].em, "2026-10-01T03:00:05.000Z", "o instante real continua registrado");
});

test("A5: consumo de um período nunca aparece no seguinte (limite do novo dia começa zerado)", async () => {
  const fake = criarProvedorFake({ id: "OPENAI", modelos: { ECONOMY: "m" }, roteiro: () => respostaFake('{"ok":true}', { entrada: 450, saida: 0 }) });
  const orcamento = orcamentoDoAmbiente({ AI_BUDGET_JSON: JSON.stringify({ porEmpresa: { tokensDiario: 1000 }, estimativa: { overheadTokens: 64 } }) });
  const { r } = roteador([fake], { orcamento }, { AI_PROVIDER_ECONOMY: "OPENAI" });
  for (let i = 0; i < 2; i += 1) assert.equal((await r.executar(pedido(), { ...alvo, hoje: "2026-09-30" })).ok, true);
  assert.equal((await r.executar(pedido(), { ...alvo, hoje: "2026-09-30" })).ok, false, "30/09 esgotado");
  assert.equal((await r.executar(pedido(), { ...alvo, hoje: "2026-10-01" })).ok, true, "01/10 tem o próprio saldo");
});

test("A5: estimativa conservadora inclui mensagens, schema, imagens e overhead configurável", () => {
  const base = { mensagens: [{ conteudo: "ação" }], esquema: { schema: { type: "object", properties: { a: { type: "string" } } } } };
  const bytes = Buffer.byteLength("ação") + Buffer.byteLength(JSON.stringify(base.esquema.schema));
  assert.equal(estimarTokensEntrada(base), bytes + ESTIMATIVA_PADRAO.tokensPorMensagem + ESTIMATIVA_PADRAO.overheadTokens);
  assert.equal(estimarTokensEntrada({ ...base, imagens: [1, 2] }) - estimarTokensEntrada(base), 2 * ESTIMATIVA_PADRAO.tokensPorImagem);
  assert.equal(estimarTokensEntrada(base, { overheadTokens: 0, tokensPorMensagem: 0 }), bytes);
  assert.ok(ESTIMATIVA_PADRAO.tokensPorImagem >= 6_000, "imagem estimada com folga");
});

test("A5: reserva órfã (processo caiu) vira ORFA pela rotina, continua contando e aceita reconciliação tardia", async () => {
  const registro = criarRegistroUsoEmMemoria();
  const periodos = { dia: "2026-09-28", mes: "2026-09" };
  const limites = [{ escopo: "EMPRESA" as const, capacidade: null, periodo: { tipo: "DIA" as const, chave: "2026-09-28" }, tokensMax: 1000, custoMaxMicros: null }];
  await registro.reservar({ id: "r1", empresaId: alvo.empresaId, capacidade: "x", correlationId: "c", em: "2026-09-28T12:00:00.000Z", periodos, tokens: 700, custoMicros: null, moeda: null, limites });
  const agora = Date.parse("2026-09-28T12:00:00.000Z") + TTL_RESERVA_MS + 1;
  assert.equal(await registro.recuperarOrfas(new Date(agora - TTL_RESERVA_MS).toISOString()), 1);
  assert.equal(registro.reservas.get("r1")!.estado, "ORFA");
  const nova = await registro.reservar({ id: "r2", empresaId: alvo.empresaId, capacidade: "x", correlationId: "c", em: "2026-09-28T12:20:00.000Z", periodos, tokens: 400, custoMicros: null, moeda: null, limites });
  assert.deepEqual(nova, { ok: false, motivo: "ORCAMENTO", recusa: { motivo: "TETO_TOKENS", escopo: "EMPRESA", periodo: "DIA" } }, "órfã continua contando: 700 + 400 > 1000");
  await assert.rejects(registro.liberar("r1", { ...usoBase(), tokensEntrada: 0, tokensSaida: 0 }), /ORFA_NAO_LIBERA/, "órfã nunca é liberada");
  await registro.reconciliar("r1", { ...usoBase(), tokensEntrada: 100, tokensSaida: 0 });
  assert.equal(registro.reservas.get("r1")!.estado, "RECONCILIADA", "reconciliação tardia troca a reserva pelo uso real");
  assert.deepEqual(registro.usos[0].periodos, periodos);
});

// ---------------------------------------------------------------- PR 13: motivo da recusa no resultado (trace)

test("PR 13: recusa de orçamento diz o teto, o escopo e o tamanho da reserva — reserva pequena cabe, a grande não", async () => {
  const fake = criarProvedorFake({ id: "OPENAI", modelos: { ECONOMY: "m" }, roteiro: () => respostaFake('{"ok":true}', { entrada: 100, saida: 10 }) });
  const orcamento = orcamentoDoAmbiente({ AI_BUDGET_JSON: JSON.stringify({ porEmpresa: { tokensDiario: 1000 }, estimativa: { overheadTokens: 0, tokensPorMensagem: 0 } }) });
  const { r } = roteador([fake], { orcamento }, { AI_PROVIDER_ECONOMY: "OPENAI" });
  const pequeno = pedido();
  assert.equal((await r.executar(pequeno, alvo)).ok, true, "reserva pequena (estilo JEV) cabe no saldo");
  const grande = { ...pedido(), maxTokensSaida: 900 };
  const recusado = await r.executar(grande, alvo);
  assert.equal(recusado.ok, false);
  assert.equal(fake.chamadas.length, 1, "a grande nunca chega ao provedor");
  const tokensReserva = estimarTokensEntrada(grande, { overheadTokens: 0, tokensPorMensagem: 0 }) + 900;
  assert.deepEqual(!recusado.ok && recusado.recusa, {
    causa: "ORCAMENTO", workload: "CLASSIFICAR_INTENCAO", capacidade: "criar_pacote",
    motivo: "TETO_TOKENS", escopo: "EMPRESA", periodo: "DIA", tokensReserva,
  });
});

test("PR 13: teto por capacidade aparece como escopo CAPACIDADE; orçamento ausente e custo sem preço têm motivo próprio", async () => {
  const fake = () => criarProvedorFake({ id: "OPENAI", modelos: { ECONOMY: "m" }, roteiro: () => respostaFake('{"ok":true}', { entrada: 1, saida: 1 }) });
  const recusa = async (budget: string | undefined) => {
    const { r } = roteador([fake()], { orcamento: orcamentoDoAmbiente(budget === undefined ? {} : { AI_BUDGET_JSON: budget }) }, { AI_PROVIDER_ECONOMY: "OPENAI" });
    const res = await r.executar(pedido(), alvo);
    assert.equal(res.ok, false);
    return !res.ok && res.recusa ? { motivo: res.recusa.motivo, escopo: res.recusa.escopo, periodo: res.recusa.periodo } : null;
  };
  assert.deepEqual(await recusa(JSON.stringify({ porEmpresa: { tokensDiario: 1_000_000 }, porCapacidade: { criar_pacote: { tokensMensal: 10 } } })), { motivo: "TETO_TOKENS", escopo: "CAPACIDADE", periodo: "MES" });
  assert.deepEqual(await recusa(undefined), { motivo: "AUSENTE", escopo: null, periodo: null });
  assert.deepEqual(await recusa("{"), { motivo: "INVALIDO", escopo: null, periodo: null });
  assert.deepEqual(await recusa(JSON.stringify({ porCapacidade: { outra: { tokensDiario: 10 } } })), { motivo: "SEM_TETO", escopo: null, periodo: null });
  assert.deepEqual(await recusa(JSON.stringify({ moeda: "USD", porEmpresa: { custoDiario: 1 } })), { motivo: "SEM_PRECO", escopo: null, periodo: null }, "precos: null");
});

test("PR 13: sucesso e falha do provedor não levam recusa (a chamada aconteceu)", async () => {
  const ok = criarProvedorFake({ id: "OPENAI", modelos: { ECONOMY: "m" }, roteiro: () => respostaFake('{"ok":true}', { entrada: 1, saida: 1 }) });
  const resOk = await roteador([ok], {}, { AI_PROVIDER_ECONOMY: "OPENAI" }).r.executar(pedido(), alvo);
  assert.equal("recusa" in resOk, false);
  const falha = criarProvedorFake({ id: "OPENAI", modelos: { ECONOMY: "m" }, roteiro: () => { throw new ErroModelo("HTTP_5XX", false); } });
  const resFalha = await roteador([falha], {}, { AI_PROVIDER_ECONOMY: "OPENAI", AI_FALLBACK_ENABLED: "false" }).r.executar(pedido(), alvo);
  assert.equal(resFalha.ok, false);
  assert.equal("recusa" in resFalha, false);
});

function usoBase() {
  return { correlationId: "c", empresaId: alvo.empresaId, estabelecimentoId: null, capacidade: "x", workload: "CLASSIFICAR_INTENCAO" as const, tier: "ECONOMY" as const, provedor: "OPENAI" as const, modelo: "m", tokensEntrada: 0, tokensSaida: 0, tokensCache: null, duracaoMs: 1, custoEstimadoMicros: null, moeda: null, sucesso: true, erro: null, fallback: false, em: "2026-09-28T13:00:00.000Z" };
}

test("PDF anexo vai como parte \"file\" só para provedor com visão; o prazo do pedido vale no lugar do padrão; custo conta as páginas", async () => {
  const pedidos: Array<{ init: RequestInit }> = [];
  const buscar = async (_url: string, init: RequestInit) => {
    pedidos.push({ init });
    return new Response(JSON.stringify({ model: "modelo-padrao", choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  };
  const comArquivo: PedidoModelo<{ ok: boolean }> = {
    ...pedido("EXTRACAO_CONTRATO"),
    arquivos: [{ mime: "application/pdf", nome: "tabela.pdf", base64: "JVBERi0=", paginas: 6 }],
    prazoMs: 90_000,
  };
  const openai = criarAdaptadorOpenAICompativel(PERFIL_OPENAI, { OPENAI_API_KEY: CHAVE, AI_OPENAI_MODEL_STANDARD: "modelo-padrao" }, buscar);
  const resultado = await openai.gerar(comArquivo, "modelo-padrao", new AbortController().signal);
  assert.equal(resultado.texto, '{"ok":true}');
  const corpo = JSON.parse(String(pedidos[0].init.body));
  const partes = corpo.messages.at(-1).content;
  assert.equal(partes[0].type, "text");
  assert.deepEqual(partes[1], { type: "file", file: { filename: "tabela.pdf", file_data: "data:application/pdf;base64,JVBERi0=" } });
  const deepseek = criarAdaptadorOpenAICompativel(PERFIL_DEEPSEEK, { DEEPSEEK_API_KEY: CHAVE, AI_DEEPSEEK_MODEL_STANDARD: "ds" }, buscar);
  await assert.rejects(deepseek.gerar(comArquivo, "ds", new AbortController().signal));
  const base = estimarTokensEntrada(pedido("EXTRACAO_CONTRATO"));
  assert.equal(estimarTokensEntrada(comArquivo) - base, 6 * ESTIMATIVA_PADRAO.tokensPorImagem);
});
