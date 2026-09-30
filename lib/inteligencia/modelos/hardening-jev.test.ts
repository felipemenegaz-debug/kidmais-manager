import assert from "node:assert/strict";
import test from "node:test";
import type { IdProvedor, ModelUsage } from "../contratos.ts";
import { criarJuizJev, prazoModeloJevDoAmbiente, PRAZO_MODELO_JEV_MS, TETO_CONFIANCA_MODELO, type PortaModeloJev } from "../jev/v1/juiz.ts";
import type { SaidaModeloJev } from "../jev/v1/contrato.ts";
import { anotarUsoModelo, novoRastreio, sanearRastreio } from "../rastreio.ts";
import { Circuito, chaveCircuito } from "./circuito.ts";
import { criarProvedorFake, respostaFake } from "./fake.ts";
import { PERFIL_DEEPSEEK, PERFIL_OPENAI, criarAdaptadorOpenAICompativel, detalheDoErro } from "./openai-compativel.ts";
import { criarRegistroUsoEmMemoria, orcamentoDoAmbiente } from "./orcamento.ts";
import { tabelaDoAmbiente } from "./precos.ts";
import { RoteadorModelos, politicaDoAmbiente, type DependenciasRoteador } from "./roteador.ts";
import { ErroModelo, type AdaptadorProvedor, type PedidoModelo } from "./tipos.ts";

/**
 * JEV model hardening (H1–H4): prazo do JEV configurável, esforço de raciocínio por tier, circuito por
 * provedor+modelo+workload, erro HTTP saneado e contabilidade correta nas falhas.
 */
const CHAVE = "sk-teste-0000000000000000000000000000";
const PROMPT_SECRETO = "texto do operador: cliente Fulano CPF 123.456.789-09";
const alvo = { empresaId: "11111111-1111-4111-8111-111111111111", capacidade: "jev_julgar", correlationId: "corr-h", hoje: "2026-09-30" };
const PRECOS = tabelaDoAmbiente({ AI_PRICING_JSON: JSON.stringify({ moeda: "USD", modelos: { "OPENAI:gpt-6-luna": { entrada: 0.1, saida: 0.5, cache: 0.01 } } }) });

function pedido(workload: PedidoModelo<unknown>["workload"] = "CLASSIFICAR_INTENCAO"): PedidoModelo<{ ok: boolean }> {
  return {
    workload,
    mensagens: [{ papel: "system", conteudo: "sistema" }, { papel: "user", conteudo: PROMPT_SECRETO }],
    esquema: { nome: "saida", schema: { type: "object" } },
    maxTokensSaida: 160,
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
    politica: politicaDoAmbiente({ AI_PROVIDER_PRIMARY: "OPENAI", AI_PROVIDER_ECONOMY: "OPENAI", AI_MODEL_MAX_RETRIES: "1", ...env }),
    adaptadores: new Map(adaptadores.map((a) => [a.id, a] as [IdProvedor, AdaptadorProvedor])),
    precos: PRECOS,
    orcamento: orcamentoDoAmbiente({ AI_BUDGET_JSON: JSON.stringify({ moeda: "USD", porEmpresa: { tokensDiario: 10_000_000 } }) }),
    registro,
    circuito: new Circuito(),
    agora: () => new Date("2026-09-30T12:00:00Z"),
    relogio: () => (t += 5),
    novoId: () => `${String(++id).padStart(8, "0")}-0000-4000-8000-00000000000h`,
    ...extra,
  };
  return { r: new RoteadorModelos(deps), registro };
}

type Capturado = { url: string; corpo: Record<string, unknown> };
function openai(respostas: Array<() => Response>, env: Record<string, string> = {}) {
  const capturados: Capturado[] = [];
  let i = 0;
  const buscar = async (url: string, init: RequestInit) => {
    capturados.push({ url, corpo: JSON.parse(String(init.body)) as Record<string, unknown> });
    return respostas[Math.min(i++, respostas.length - 1)]();
  };
  const adaptador = criarAdaptadorOpenAICompativel(PERFIL_OPENAI, { OPENAI_API_KEY: CHAVE, AI_OPENAI_MODEL_ECONOMY: "gpt-6-luna", AI_OPENAI_MODEL_STANDARD: "gpt-6-luna", ...env }, buscar);
  return { adaptador, capturados };
}
const erroHttp = (status: number, erro: unknown) => () => new Response(JSON.stringify({ error: erro }), { status, headers: { "content-type": "application/json" } });
const ok = (conteudo: string | null, usage: Record<string, unknown> | null = { prompt_tokens: 400, completion_tokens: 60 }) => () =>
  new Response(JSON.stringify({ model: "gpt-6-luna", choices: [{ message: { content: conteudo } }], ...(usage ? { usage } : {}) }), { status: 200 });

// ---------------------------------------------------------------- H1: prazo do JEV

test("H1: prazo do JEV vem do ambiente, com padrão seguro, faixa validada e teto no timeout do roteador", () => {
  assert.equal(prazoModeloJevDoAmbiente({}, 20_000), PRAZO_MODELO_JEV_MS, "ausente ⇒ padrão auditado (2,5 s)");
  assert.equal(prazoModeloJevDoAmbiente({ AI_JEV_MODEL_TIMEOUT_MS: "8000" }, 20_000), 8_000);
  assert.equal(prazoModeloJevDoAmbiente({ AI_JEV_MODEL_TIMEOUT_MS: "8000" }, 5_000), 5_000, "nunca maior que o timeout do roteador");
  for (const invalido of ["abc", "", "999", "30001", "8000.5", "-1", "1e4", "0x1F40", " 8000x", "+8000"]) {
    assert.equal(prazoModeloJevDoAmbiente({ AI_JEV_MODEL_TIMEOUT_MS: invalido }, 20_000), PRAZO_MODELO_JEV_MS, `inválido "${invalido}" ⇒ padrão, nunca sem prazo`);
  }
  assert.equal(prazoModeloJevDoAmbiente({ AI_JEV_MODEL_TIMEOUT_MS: "30000" }, 120_000), 30_000);
});

const saidaJev: SaidaModeloJev = { intent: "CONSULTA", actionSensitivity: "READ", humanNeed: "NAO", risk: "LOW", contextSufficiency: "SUFFICIENT", confidence: 0.9, reasonCodes: ["SINAL_CONSULTA"] };
function portaLenta(atrasoMs: number): { porta: PortaModeloJev; chamadas: () => number } {
  let n = 0;
  return {
    chamadas: () => n,
    porta: {
      disponivel: () => true,
      async executar<T>(p: PedidoModelo<T>) {
        n += 1;
        await new Promise((ok) => setTimeout(ok, atrasoMs));
        return { ok: true as const, valor: p.validar(JSON.stringify(saidaJev)), usos: [], provedor: "OPENAI" as IdProvedor, modelo: "gpt-6-luna" };
      },
    },
  };
}

test("H1: modelo lento (escala de 3–4 s × prazo de 2,5 s) ⇒ PRAZO; com o prazo configurado acima da latência, o julgamento combina o modelo", async () => {
  // Controle negativo: o comportamento que falhou em staging (latência > prazo padrão) continua virando PRAZO.
  const lento = portaLenta(80);
  const curto = await criarJuizJev({ modelo: lento.porta, prazoModeloMs: 25 }).julgar({ texto: "hmm aquilo lá", tela: "geral", temEntidade: false });
  assert.equal(curto.causaModelo, "PRAZO");
  assert.equal(curto.julgamento.origem, "FALLBACK_REGRAS");
  // Correção: prazo acima da latência observada ⇒ o resultado do modelo entra (com teto de confiança e o mais restritivo vence).
  const configurado = await criarJuizJev({ modelo: portaLenta(80).porta, prazoModeloMs: 2_000 }).julgar({ texto: "hmm aquilo lá", tela: "geral", temEntidade: false });
  assert.equal(configurado.causaModelo, null);
  assert.equal(configurado.julgamento.origem, "COMBINADO");
  assert.ok(configurado.julgamento.intent.confidence <= TETO_CONFIANCA_MODELO, "teto de confiança do modelo");
});

test("H1: caminho determinístico não depende do prazo (regras confiantes não consultam o modelo)", async () => {
  const lento = portaLenta(10_000);
  const inicio = Date.now();
  const r = await criarJuizJev({ modelo: lento.porta, prazoModeloMs: 25 }).julgar({ texto: "Quais contratos estão pendentes?", tela: "geral", temEntidade: false });
  assert.equal(lento.chamadas(), 0);
  assert.equal(r.julgamento.origem, "REGRAS");
  assert.ok(Date.now() - inicio < 500);
});

// ---------------------------------------------------------------- esforço de raciocínio por tier

test("reasoning_effort: configurado por tier (ECONOMY) e só nele; inválido ou ausente ⇒ não enviado; DeepSeek nunca envia", async () => {
  const { adaptador, capturados } = openai([ok('{"ok":true}')], { AI_OPENAI_REASONING_EFFORT_ECONOMY: "none" });
  const { r } = roteador([adaptador]);
  assert.equal((await r.executar(pedido("CLASSIFICAR_INTENCAO"), alvo)).ok, true);
  assert.equal(capturados[0].corpo.reasoning_effort, "none");
  assert.equal(capturados[0].corpo.max_completion_tokens, 160);
  await r.executar(pedido("ANALISE_ADMINISTRATIVA"), { ...alvo, capacidade: "copiloto_explicar" });
  assert.equal("reasoning_effort" in capturados[1].corpo, false, "STANDARD sem configuração: padrão do modelo");

  for (const invalido of ["minimal", "minimo", "LOWW", "", "none; drop"]) {
    const x = openai([ok('{"ok":true}')], { AI_OPENAI_REASONING_EFFORT_ECONOMY: invalido });
    await roteador([x.adaptador]).r.executar(pedido(), alvo);
    assert.equal("reasoning_effort" in x.capturados[0].corpo, false, `inválido "${invalido}" não é enviado`);
  }
  const ds: Capturado[] = [];
  const deepseek = criarAdaptadorOpenAICompativel(PERFIL_DEEPSEEK, { DEEPSEEK_API_KEY: CHAVE, AI_DEEPSEEK_MODEL_ECONOMY: "deepseek-chat", AI_OPENAI_REASONING_EFFORT_ECONOMY: "low" },
    async (url, init) => { ds.push({ url, corpo: JSON.parse(String(init.body)) as Record<string, unknown> }); return ok('{"ok":true}')(); });
  await roteador([deepseek], {}, { AI_PROVIDER_ECONOMY: "DEEPSEEK" }).r.executar(pedido(), alvo);
  assert.equal("reasoning_effort" in ds[0].corpo, false);
});

// ---------------------------------------------------------------- H2: circuito por provedor + modelo + workload

test("H2: falhas repetidas do JEV (ECONOMY) abrem só o circuito dele; o Copiloto (STANDARD) segue funcionando", async () => {
  const circuito = new Circuito(3, 60_000);
  const falhas = { n: 0 };
  const provedor = criarProvedorFake({
    id: "OPENAI", modelos: { ECONOMY: "gpt-6-luna", STANDARD: "gpt-6-luna" },
    roteiro: (p) => (p.workload === "CLASSIFICAR_INTENCAO" ? (falhas.n++, new ErroModelo("HTTP_5XX", false)) : respostaFake('{"ok":true}')),
  });
  const { r } = roteador([provedor], { circuito }, { AI_MODEL_MAX_RETRIES: "0" });
  for (let i = 0; i < 3; i += 1) assert.equal((await r.executar(pedido("CLASSIFICAR_INTENCAO"), alvo)).ok, false);
  const bloqueado = await r.executar(pedido("CLASSIFICAR_INTENCAO"), alvo);
  assert.equal((bloqueado as { causa: string }).causa, "CIRCUITO_ABERTO", "mesma chave: circuito aberto");
  assert.equal(falhas.n, 3, "circuito aberto não chama o provedor");
  const copiloto = await r.executar(pedido("ANALISE_ADMINISTRATIVA"), { ...alvo, capacidade: "copiloto_explicar" });
  assert.equal(copiloto.ok, true, "workload diferente não é afetado");
});

test("H2: chave inclui o modelo; cooldown reabre em meio-aberto (uma tentativa) e sucesso fecha", () => {
  const c = new Circuito(2, 1_000);
  const a = chaveCircuito("OPENAI", "gpt-6-luna", "CLASSIFICAR_INTENCAO");
  const b = chaveCircuito("OPENAI", "outro-modelo", "CLASSIFICAR_INTENCAO");
  const d = chaveCircuito("DEEPSEEK", "gpt-6-luna", "CLASSIFICAR_INTENCAO");
  c.falha(a, 0);
  c.falha(a, 0);
  assert.equal(c.permite(a, 10), false);
  assert.equal(c.permite(b, 10), true, "outro modelo, mesmo workload: não afetado");
  assert.equal(c.permite(d, 10), true, "outro provedor: não afetado");
  assert.equal(c.permite(a, 1_100), true, "depois da janela: uma tentativa");
  assert.equal(c.permite(a, 1_100), false, "meio-aberto: só uma");
  c.sucesso(a);
  assert.equal(c.permite(a, 1_200), true);
});

test("H2: sem retry storm — retries são limitados e cada tentativa conta uma chamada", async () => {
  let chamadas = 0;
  const provedor = criarProvedorFake({ id: "OPENAI", modelos: { ECONOMY: "gpt-6-luna" }, roteiro: () => { chamadas += 1; return new ErroModelo("HTTP_5XX", true); } });
  const r = await roteador([provedor], { circuito: new Circuito(10, 60_000) }, { AI_MODEL_MAX_RETRIES: "2" }).r.executar(pedido(), alvo);
  assert.equal(chamadas, 3);
  assert.equal(r.usos.length, 3);
});

// ---------------------------------------------------------------- H3: erro HTTP saneado

test("H3: 4xx/5xx carregam só status + type/code/param saneados; mensagem, prompt e chave nunca saem", async () => {
  const casos: Array<{ status: number; erro: unknown; causa: string; tentavel: boolean; esperado: Record<string, unknown> }> = [
    { status: 400, erro: { type: "invalid_request_error", code: null, param: "response_format", message: `Bad schema near ${PROMPT_SECRETO}` }, causa: "HTTP_4XX", tentavel: false, esperado: { status: 400, tipo: "invalid_request_error", codigo: null, parametro: "response_format" } },
    { status: 401, erro: { type: "invalid_request_error", code: "invalid_api_key", message: `Incorrect API key provided: ${CHAVE}` }, causa: "HTTP_4XX", tentavel: false, esperado: { status: 401, tipo: "invalid_request_error", codigo: "invalid_api_key", parametro: null } },
    { status: 403, erro: { type: "permission_error", code: "model_not_allowed" }, causa: "HTTP_4XX", tentavel: false, esperado: { status: 403, tipo: "permission_error", codigo: "model_not_allowed", parametro: null } },
    { status: 404, erro: { type: "invalid_request_error", code: "model_not_found", param: "model" }, causa: "HTTP_4XX", tentavel: false, esperado: { status: 404, tipo: "invalid_request_error", codigo: "model_not_found", parametro: "model" } },
    { status: 429, erro: { type: "insufficient_quota", code: "credit_balance_exhausted", message: "You exceeded your current quota" }, causa: "HTTP_4XX", tentavel: false, esperado: { status: 429, tipo: "insufficient_quota", codigo: "credit_balance_exhausted", parametro: null } },
    { status: 429, erro: { type: "requests", code: "rate_limit_exceeded" }, causa: "HTTP_4XX", tentavel: true, esperado: { status: 429, tipo: "requests", codigo: "rate_limit_exceeded", parametro: null } },
    { status: 503, erro: { type: "server_error", code: null }, causa: "HTTP_5XX", tentavel: true, esperado: { status: 503, tipo: "server_error", codigo: null, parametro: null } },
  ];
  for (const c of casos) {
    const { adaptador } = openai([erroHttp(c.status, c.erro)]);
    const erro = await adaptador.gerar(pedido(), "gpt-6-luna", new AbortController().signal).then(() => null, (e: unknown) => e);
    assert.ok(erro instanceof ErroModelo, `${c.status}`);
    assert.equal(erro.causa, c.causa);
    assert.equal(erro.tentavel, c.tentavel, `${c.status} ${JSON.stringify(c.erro)}`);
    assert.deepEqual(erro.detalhe, c.esperado);
    const serializado = JSON.stringify({ detalhe: erro.detalhe, mensagem: erro.message });
    for (const proibido of [CHAVE, "Fulano", "123.456.789-09", "exceeded your current", "Bad schema", "Incorrect"]) assert.equal(serializado.includes(proibido), false, `${c.status}: ${proibido}`);
  }
});

test("H3: corpo inválido, gigante ou com identificadores maliciosos ⇒ só o status (campos fora do alfabeto viram null)", async () => {
  const semJson = await detalheDoErro(new Response("<html>502 Bad Gateway</html>", { status: 502 }));
  assert.deepEqual(semJson, { status: 502, tipo: null, codigo: null, parametro: null });
  const vazio = await detalheDoErro(new Response(null, { status: 500 }));
  assert.deepEqual(vazio, { status: 500, tipo: null, codigo: null, parametro: null });
  const malicioso = await detalheDoErro(new Response(JSON.stringify({ error: { type: "joao@exemplo.com", code: "https://x.invalid/a", param: "a b c", message: "x" } }), { status: 400 }));
  assert.deepEqual(malicioso, { status: 400, tipo: null, codigo: null, parametro: null });
  const grande = await detalheDoErro(new Response(`{"error":{"type":"x","pad":"${"a".repeat(20_000)}"}}`, { status: 400 }));
  assert.deepEqual(grande, { status: 400, tipo: null, codigo: null, parametro: null }, "acima do limite de leitura: não interpreta");
  // Leitura realmente limitada: corpo infinito ⇒ lê pouco mais de 8 KiB, cancela o stream e responde só o status.
  let lidos = 0;
  let cancelado = false;
  const infinito = new ReadableStream<Uint8Array>({
    pull(c) { lidos += 1024; c.enqueue(new Uint8Array(1024).fill(0x61)); },
    cancel() { cancelado = true; },
  });
  assert.deepEqual(await detalheDoErro(new Response(infinito, { status: 400 })), { status: 400, tipo: null, codigo: null, parametro: null });
  assert.equal(cancelado, true);
  assert.ok(lidos <= 16 * 1024, `leu ${lidos} bytes`);
});

test("H3: 429 de cota esgotada não é repetido; o detalhe chega ao uso e ao trace (fechado e saneado), nunca à 055a", async () => {
  const { adaptador, capturados } = openai([erroHttp(429, { type: "insufficient_quota", code: "credit_balance_exhausted", message: "billing" })]);
  const { r, registro } = roteador([adaptador], {}, { AI_MODEL_MAX_RETRIES: "2" });
  const res = await r.executar(pedido(), alvo);
  assert.equal(res.ok, false);
  assert.equal(capturados.length, 1, "sem retry para cota esgotada");
  const uso = res.usos[0];
  assert.deepEqual([uso.erro, uso.tokensEntrada, uso.tokensSaida, uso.custoEstimadoMicros], ["HTTP_4XX", 0, 0, null], "recusa antes do processamento: zero conhecido");
  assert.deepEqual(uso.detalheErro, { status: 429, tipo: "insufficient_quota", codigo: "credit_balance_exhausted", parametro: null });
  assert.equal([...registro.reservas.values()][0].estado, "LIBERADA");

  const rastreio = novoRastreio("inteligencia.conversa", "req-h3");
  anotarUsoModelo(rastreio, res.usos);
  const saneado = sanearRastreio(rastreio);
  assert.deepEqual(saneado.errosModelo, [{ causa: "HTTP_4XX", workload: "CLASSIFICAR_INTENCAO", status: 429, tipo: "insufficient_quota", codigo: "credit_balance_exhausted", parametro: null }]);
  assert.equal(JSON.stringify(saneado).includes("billing"), false);
});

test("H3: trace guarda no máximo 5 erros por pedido e não inventa detalhe quando o provedor não informou", () => {
  const base: ModelUsage = {
    correlationId: "c", empresaId: alvo.empresaId, estabelecimentoId: null, capacidade: "jev_julgar", workload: "CLASSIFICAR_INTENCAO", tier: "ECONOMY",
    provedor: "OPENAI", modelo: "gpt-6-luna", tokensEntrada: null, tokensSaida: null, tokensCache: null, duracaoMs: 1, custoEstimadoMicros: null, moeda: null,
    sucesso: false, erro: "TIMEOUT", fallback: false, em: "2026-09-30T12:00:00Z",
  };
  const rastreio = novoRastreio("inteligencia.conversa", "req-5");
  anotarUsoModelo(rastreio, Array.from({ length: 8 }, () => base));
  assert.equal(rastreio.errosModelo.length, 5);
  assert.deepEqual(rastreio.errosModelo[0], { causa: "TIMEOUT", workload: "CLASSIFICAR_INTENCAO", status: null, tipo: null, codigo: null, parametro: null });
  const sucesso = novoRastreio("inteligencia.conversa", "req-ok");
  anotarUsoModelo(sucesso, [{ ...base, sucesso: true, erro: null, tokensEntrada: 10, tokensSaida: 5 }]);
  assert.deepEqual(sucesso.errosModelo, []);
});

// ---------------------------------------------------------------- H4: contabilidade nas falhas

test("H4: 200 sem texto COM usage (raciocínio esgotou o teto) ⇒ uso real registrado, custo calculado, circuito saudável", async () => {
  const circuito = new Circuito(1, 60_000);
  const { adaptador } = openai([ok("", { prompt_tokens: 300, completion_tokens: 160, completion_tokens_details: { reasoning_tokens: 160 } })]);
  const { r, registro } = roteador([adaptador], { circuito }, { AI_MODEL_MAX_RETRIES: "0" });
  const res = await r.executar(pedido(), alvo);
  assert.equal(res.ok, false);
  assert.equal((res as { causa: string }).causa, "RESPOSTA_INVALIDA");
  const uso = res.usos[0];
  assert.deepEqual([uso.tokensEntrada, uso.tokensSaida, uso.custoEstimadoMicros, uso.moeda, uso.erro], [300, 160, 110, "USD", "RESPOSTA_INVALIDA"], "0.1×300 + 0.5×160 = 110");
  assert.equal([...registro.reservas.values()][0].estado, "RECONCILIADA");
  assert.equal(circuito.permite(chaveCircuito("OPENAI", "gpt-6-luna", "CLASSIFICAR_INTENCAO"), 0), true, "provedor respondeu: não conta como falha do circuito");
});

test("H4: 200 sem texto e sem usage ⇒ uso DESCONHECIDO (null), nunca zero; corpo ilegível idem", async () => {
  for (const resposta of [ok(null, null), () => new Response("isto não é json", { status: 200 })]) {
    const { adaptador } = openai([resposta]);
    const res = await roteador([adaptador], {}, { AI_MODEL_MAX_RETRIES: "0" }).r.executar(pedido(), alvo);
    const uso = res.usos[0];
    assert.equal(uso.erro, "RESPOSTA_INVALIDA");
    assert.equal(uso.tokensEntrada, null);
    assert.equal(uso.tokensSaida, null);
    assert.equal(uso.custoEstimadoMicros, null);
  }
});

test("H4: timeout e 5xx ⇒ desconhecido; retry soma chamadas no trace; conhecido + desconhecido nunca vira custo conhecido", async () => {
  let n = 0;
  const provedor = criarProvedorFake({
    id: "OPENAI", modelos: { ECONOMY: "gpt-6-luna" },
    roteiro: () => (++n === 1 ? new ErroModelo("HTTP_5XX", true) : respostaFake('{"ok":true}', { entrada: 400, saida: 60 })),
  });
  const res = await roteador([provedor], { circuito: new Circuito(10, 60_000) }, { AI_MODEL_MAX_RETRIES: "1" }).r.executar(pedido(), alvo);
  assert.equal(res.ok, true);
  assert.equal(res.usos.length, 2);
  assert.deepEqual([res.usos[0].tokensEntrada, res.usos[0].custoEstimadoMicros], [null, null]);
  assert.deepEqual([res.usos[1].tokensEntrada, res.usos[1].custoEstimadoMicros], [400, 70], "0.1×400 + 0.5×60 = 70");
  const rastreio = novoRastreio("inteligencia.conversa", "req-h4");
  anotarUsoModelo(rastreio, res.usos);
  assert.equal(rastreio.chamadasModelo, 2);
  assert.equal(rastreio.custoConhecidoMicros, 70);
  assert.equal(rastreio.chamadasCustoDesconhecido, 1);
  assert.equal(rastreio.custoEstimadoMicros, null, "desconhecido + conhecido ≠ conhecido");
  assert.equal(rastreio.tokensTotal, null);
});

test("H4: múltiplas chamadas no mesmo pedido acumulam tokens e custo (JEV + Copiloto)", async () => {
  const { adaptador } = openai([ok('{"ok":true}', { prompt_tokens: 380, completion_tokens: 40 }), ok('{"ok":true}', { prompt_tokens: 458, completion_tokens: 198 })]);
  const { r } = roteador([adaptador]);
  const jev = await r.executar(pedido("CLASSIFICAR_INTENCAO"), alvo);
  const cop = await r.executar(pedido("ANALISE_ADMINISTRATIVA"), { ...alvo, capacidade: "copiloto_explicar" });
  const rastreio = novoRastreio("inteligencia.conversa", "req-multi");
  anotarUsoModelo(rastreio, jev.usos);
  anotarUsoModelo(rastreio, cop.usos);
  assert.equal(rastreio.chamadasModelo, 2);
  assert.equal(rastreio.tokensTotal, 380 + 40 + 458 + 198);
  assert.equal(rastreio.custoConhecidoMicros, 58 + 145, "0.1×380+0.5×40=58; 0.1×458+0.5×198=144,8→145");
  assert.equal(rastreio.custoEstimadoMicros, 203);
  assert.deepEqual(rastreio.errosModelo, []);
});
