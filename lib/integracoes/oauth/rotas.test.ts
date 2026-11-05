import assert from "node:assert/strict";
import test from "node:test";
import { ENV_OK } from "../mcp/apoio-mcp.test.ts";
import type { BuscaDocumento } from "./cimd.ts";
import { RepositorioOAuthMemoria } from "./memoria-teste.ts";
import { JanelasFixas } from "../mcp/janelas.ts";
import { LIMITES_PUBLICOS, LimitadorPublicoOAuth, atenderAutorizacao, atenderToken, lerCorpoLimitado, rotuloCliente, type DependenciasRotasOAuth } from "./rotas.ts";

/** Revisão P1-2 / P2-8: bordas públicas do OAuth — canal antes do corpo, limites, corpo limitado, sem auditoria anônima, teto e expurgo. */
const CHATGPT = "https://chatgpt.com/oauth/client.json";
const CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect";
const BASE = "http://127.0.0.1:9";

const cimd: BuscaDocumento = async (url) => url.href === CHATGPT
  ? { status: 200, tipo: "application/json", corpo: JSON.stringify({ client_id: CHATGPT, client_name: "ChatGPT", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" }) }
  : { status: 404, tipo: "application/json", corpo: "{}" };

function montar(over: { env?: Record<string, string | undefined>; limites?: Partial<Record<keyof typeof LIMITES_PUBLICOS, number>>; origem?: string | null } = {}) {
  const agora = { t: Date.now() };
  const repo = new RepositorioOAuthMemoria(() => new Date(agora.t));
  const logs: string[] = [];
  const limites = new LimitadorPublicoOAuth(() => agora.t, { ...LIMITES_PUBLICOS, ...over.limites }, (l) => logs.push(l));
  const deps: DependenciasRotasOAuth = {
    oauth: { env: over.env ?? ENV_OK, repo, buscarCimd: cimd, agora: () => new Date(agora.t) },
    limites,
    origem: () => over.origem ?? null,
  };
  return { deps, repo, logs, agora };
}

const autorizar = (extra: Record<string, string> = {}) => new Request(`${BASE}/api/mcp/oauth/authorize?${new URLSearchParams({
  response_type: "code", client_id: CHATGPT, redirect_uri: CALLBACK, code_challenge: "A".repeat(43), code_challenge_method: "S256", resource: ENV_OK.MCP_PUBLIC_URL, ...extra,
})}`);

/** Corpo que FALHA se alguém tentar lê-lo: prova que a recusa veio antes da leitura. */
function corpoProibido() {
  let lido = false;
  const body = new ReadableStream<Uint8Array>({ pull() { lido = true; throw new Error("corpo lido"); } }, { highWaterMark: 0 });
  return { body, lido: () => lido };
}

test("canal desligado: authorize e token respondem 503 sem ler o corpo nem gravar nada", async () => {
  const { deps, repo } = montar({ env: { ...ENV_OK, MCP_ENABLED: "false" } });
  assert.equal((await atenderAutorizacao(autorizar(), deps)).status, 503);
  const c = corpoProibido();
  const r = await atenderToken(new Request(`${BASE}/api/mcp/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: c.body, duplex: "half" } as RequestInit), deps);
  assert.equal(r.status, 503);
  assert.equal(c.lido(), false, "corpo não foi lido");
  assert.equal(repo.pedidos.size + repo.auditoria.length, 0);
});

test("corpo do token: acima de 8 KiB recusa durante a leitura (com ou sem content-length) e cancela o fluxo", async () => {
  let entregues = 0;
  let cancelado = false;
  const grande = new ReadableStream<Uint8Array>({
    pull(ctrl) { entregues += 1; ctrl.enqueue(new Uint8Array(4096).fill(97)); if (entregues > 1000) ctrl.close(); },
    cancel() { cancelado = true; },
  });
  const pedido = new Request(`${BASE}/x`, { method: "POST", body: grande, duplex: "half" } as RequestInit);
  assert.deepEqual(await lerCorpoLimitado(pedido, LIMITES_PUBLICOS.corpoTokenBytes, 5000), { ok: false, motivo: "GRANDE" });
  assert.ok(entregues <= 4, `parou cedo (${entregues} blocos)`);
  await new Promise((ok) => setImmediate(ok));
  assert.equal(cancelado, true, "fluxo cancelado (sem esperar o cancelamento)");
  const declarado = new Request(`${BASE}/x`, { method: "POST", headers: { "content-length": "999999" }, body: "a" });
  assert.deepEqual(await lerCorpoLimitado(declarado, 8192, 5000), { ok: false, motivo: "GRANDE" }, "content-length acima do teto");
  assert.deepEqual(await lerCorpoLimitado(new Request(`${BASE}/x`, { method: "POST", body: "grant_type=x" }), 8192, 5000), { ok: true, texto: "grant_type=x" });
  const { deps } = montar();
  const r = await atenderToken(new Request(`${BASE}/api/mcp/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=".padEnd(9000, "b") }), deps);
  assert.equal(r.status, 413);
});

test("tentativas anônimas inválidas não gravam auditoria no banco; log agregado no máximo 1 vez por minuto", async () => {
  const { deps, repo, logs, agora } = montar();
  for (let i = 0; i < 20; i += 1) await atenderAutorizacao(autorizar({ client_id: `https://evil.example/c${i}.json` }), deps);
  for (let i = 0; i < 5; i += 1) await atenderAutorizacao(autorizar({ redirect_uri: "https://evil.example/cb" }), deps);
  for (let i = 0; i < 5; i += 1) await atenderToken(new Request(`${BASE}/t`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `grant_type=refresh_token&client_id=${encodeURIComponent(CHATGPT)}&refresh_token=kmr_${"x".repeat(43)}` }), deps);
  assert.equal(repo.auditoria.length, 0, "nenhuma linha de auditoria anônima");
  assert.equal(repo.pedidos.size, 0);
  assert.equal(logs.length, 1, "uma linha agregada");
  assert.doesNotMatch(logs[0], /evil|kmr_|http/);
  agora.t += 61_000;
  await atenderAutorizacao(autorizar({ client_id: "https://evil.example/z.json" }), deps);
  assert.equal(logs.length, 2);
});

test("limites: por cliente, por origem confiável e global devolvem 429 com Retry-After antes de trabalhar", async () => {
  const porCliente = montar({ limites: { authorizePorCliente: 3 } });
  const status: number[] = [];
  for (let i = 0; i < 4; i += 1) status.push((await atenderAutorizacao(autorizar(), porCliente.deps)).status);
  assert.deepEqual(status, [302, 302, 302, 429]);
  assert.equal(porCliente.repo.pedidos.size, 3, "o recusado não gravou pedido");
  const porOrigem = montar({ limites: { authorizePorOrigem: 2 }, origem: "203.0.113.7" });
  await atenderAutorizacao(autorizar(), porOrigem.deps);
  await atenderAutorizacao(autorizar({ client_id: "https://evil.example/a.json" }), porOrigem.deps);
  const r = await atenderAutorizacao(autorizar(), porOrigem.deps);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get("retry-after")) >= 1);
  const global = montar({ limites: { tokenGlobal: 1 } });
  const t = () => atenderToken(new Request(`${BASE}/t`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=x" }), global.deps);
  assert.equal((await t()).status, 400);
  assert.equal((await t()).status, 429);
});

test("teto persistente de pedidos pendentes por cliente e expurgo de vencidos", async () => {
  const { deps, repo, agora } = montar({ limites: { pedidosPendentesPorCliente: 2, expurgoIntervaloMs: 0 } });
  assert.equal((await atenderAutorizacao(autorizar(), deps)).status, 302);
  assert.equal((await atenderAutorizacao(autorizar(), deps)).status, 302);
  assert.equal((await atenderAutorizacao(autorizar(), deps)).status, 429, "teto de pendentes");
  agora.t += 2 * 3_600_000;
  assert.equal((await atenderAutorizacao(autorizar(), deps)).status, 302, "vencidos não contam e são expurgados");
  assert.equal(repo.pedidos.size, 1);
});

// ---------------------------------------------------------------- rodada 2 da revisão (achados 1, 2, 5 e 6)

test("achado 1: recusas não criam nem zeram janelas; janela vigente nunca é desalojada (global sobrevive a 10 mil client_id)", async () => {
  const { deps, repo } = montar({ limites: { authorizeGlobal: 5, authorizePorCliente: 100, maxChaves: 8 } });
  const status: number[] = [];
  for (let i = 0; i < 10_050; i += 1) status.push((await atenderAutorizacao(autorizar({ client_id: `https://evil.example/c${i}.json` }), deps)).status);
  assert.equal(status.filter((x) => x !== 429).length, 5, "só as 5 vagas globais foram usadas");
  assert.equal((await atenderAutorizacao(autorizar(), deps)).status, 429, "o limite global continua valendo depois da enxurrada");
  assert.ok(deps.limites.tamanho() <= 8, `mapa limitado (${deps.limites.tamanho()})`);
  assert.equal(repo.pedidos.size, 0);

  // Unidade: mapa cheio de janelas VIGENTES recusa a chave nova (fail-closed) sem mexer nas existentes.
  const j = new JanelasFixas(2);
  assert.equal(j.admitir([["g", 10], ["a", 10]], 0), null);
  assert.ok(j.admitir([["g", 10], ["b", 10]], 1_000)! >= 1, "sem espaço: recusa");
  assert.equal(j.usados("g", 1_000), 1, "a recusa não consumiu nem zerou a global");
  assert.equal(j.admitir([["g", 10], ["a", 10]], 2_000), null, "chaves existentes seguem funcionando");
  assert.equal(j.usados("g", 2_000), 2);
  assert.equal(j.admitir([["g", 10], ["b", 10]], 61_000), null, "depois de vencidas, a varredura libera espaço");
});

test("achado 1 (controle): limite cheio recusa sem reiniciar a janela, mesmo repetido muitas vezes", () => {
  let agora = 0;
  const l = new LimitadorPublicoOAuth(() => agora, { ...LIMITES_PUBLICOS, maxChaves: 3 }, () => undefined);
  assert.equal(l.tentar([["x", 1]]), null);
  for (let i = 0; i < 1000; i += 1) assert.notEqual(l.tentar([["x", 1]]), null);
  agora = 59_999;
  assert.notEqual(l.tentar([["x", 1]]), null, "ainda na mesma janela");
  agora = 60_000;
  assert.equal(l.tentar([["x", 1]]), null, "nova janela só pelo tempo");
});

test("achado 2: teto de pendentes é atômico sob pedidos concorrentes (memória; entre conexões: suíte PostgreSQL)", async () => {
  const { deps, repo } = montar({ limites: { pedidosPendentesPorCliente: 3 } });
  const status = await Promise.all(Array.from({ length: 12 }, () => atenderAutorizacao(autorizar(), deps).then((r) => r.status)));
  assert.equal(status.filter((x) => x === 302).length, 3);
  assert.equal(status.filter((x) => x === 429).length, 9);
  assert.equal(repo.pedidos.size, 3, "nunca acima do teto");
});

test("achado 5: leitura do corpo tem prazo total e número máximo de leituras simultâneas", async () => {
  const pendurado = () => new ReadableStream<Uint8Array>({ start(ctrl) { ctrl.enqueue(new Uint8Array([97])); } }); // nunca fecha
  const inicio = Date.now();
  const r = await lerCorpoLimitado(new Request(`${BASE}/x`, { method: "POST", body: pendurado(), duplex: "half" } as RequestInit), 8192, 80);
  assert.deepEqual(r, { ok: false, motivo: "PRAZO" });
  assert.ok(Date.now() - inicio < 2000, "terminou pelo prazo");

  const { deps } = montar({ limites: { leiturasCorpoSimultaneas: 1, corpoPrazoMs: 150 } });
  const token = (body: BodyInit) => atenderToken(new Request(`${BASE}/t`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, duplex: "half" } as RequestInit), deps);
  const lenta = token(pendurado());
  await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(deps.limites.leiturasEmCurso(), 1);
  const c = corpoProibido();
  const segunda = await token(c.body);
  assert.equal(segunda.status, 503, "acima do número de leituras simultâneas");
  assert.equal(c.lido(), false, "a recusada nem começou a ler");
  assert.equal((await lenta).status, 408, "a lenta termina pelo prazo");
  assert.equal(deps.limites.leiturasEmCurso(), 0, "vaga devolvida");
  assert.equal((await token("grant_type=x")).status, 400, "depois volta a aceitar");
});

test("achado 6 (A10): TODA recusa das bordas soma exatamente 1 no agregado, sem linha no banco; dimensões sanitizadas e limitadas", async () => {
  const { deps, repo, logs } = montar();
  const total = () => deps.limites.totalContadas();
  const form = (corpo: string, extra: Record<string, string> = {}) => new Request(`${BASE}/t`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...extra }, body: corpo });
  const casos: Array<[string, () => Promise<Response>]> = [
    ["CIMD desconhecido", () => atenderAutorizacao(autorizar({ client_id: "https://evil.example/c.json" }), deps)],
    ["redirect divergente", () => atenderAutorizacao(autorizar({ redirect_uri: "https://evil.example/cb" }), deps)],
    ["parâmetro duplicado", () => atenderAutorizacao(new Request(`${autorizar().url}&scope=a&scope=b`), deps)],
    ["state inválido", () => atenderAutorizacao(autorizar({ state: "x".repeat(501) }), deps)],
    ["response_type", () => atenderAutorizacao(autorizar({ response_type: "token" }), deps)],
    ["PKCE", () => atenderAutorizacao(autorizar({ code_challenge_method: "plain" }), deps)],
    ["resource", () => atenderAutorizacao(autorizar({ resource: "https://outro.example/api/mcp" }), deps)],
    ["escopo", () => atenderAutorizacao(autorizar({ scope: "admin:write" }), deps)],
    ["método", () => atenderToken(new Request(`${BASE}/t`, { method: "GET" }), deps)],
    ["content-type", () => atenderToken(new Request(`${BASE}/t`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), deps)],
    ["corpo grande", () => atenderToken(form("a=".padEnd(9000, "b")), deps)],
    ["token duplicado", () => atenderToken(form("grant_type=refresh_token&grant_type=refresh_token"), deps)],
    ["grant_type", () => atenderToken(form("grant_type=password"), deps)],
    ["token resource", () => atenderToken(form("grant_type=refresh_token&resource=https%3A%2F%2Foutro.example"), deps)],
    ["token PKCE", () => atenderToken(form("grant_type=authorization_code&code=kmc_x"), deps)],
    ["refresh inexistente", () => atenderToken(form(`grant_type=refresh_token&client_id=${encodeURIComponent(CHATGPT)}&refresh_token=kmr_${"x".repeat(43)}`), deps)],
  ];
  for (const [nome, executar] of casos) {
    const antes = total();
    const r = await executar();
    assert.ok(r.status >= 300, `${nome}: recusado (${r.status})`);
    assert.equal(total() - antes, 1, `${nome}: contado exatamente uma vez`);
  }
  assert.equal(repo.auditoria.length, 0, "nenhuma linha anônima no banco");
  const chaves = [...deps.limites.pendentes().keys(), ...logs].join(" ");
  assert.doesNotMatch(chaves, /evil|http|kmr_|kmc_/, "rótulos sanitizados");
  assert.match(chaves, /@chatgpt\.com/, "cliente conhecido pelo host da allowlist");
  assert.match(chaves, /@h[0-9a-f]{8}/, "desconhecido só por hash curto");

  const desligado = montar({ env: { ...ENV_OK, MCP_ENABLED: "false" } });
  await atenderAutorizacao(autorizar(), desligado.deps);
  assert.equal(desligado.deps.limites.totalContadas(), 1, "canal desligado também é contado");
  assert.match(desligado.logs.join(" "), /CANAL_DESLIGADO@-=1/);
});

test("achado 6 (A10): agregado sai pelo temporizador sem tráfego novo e o conjunto de dimensões é limitado", () => {
  let agora = 0;
  const logs: string[] = [];
  const l = new LimitadorPublicoOAuth(() => agora, { ...LIMITES_PUBLICOS, dimensoesLog: 3 }, (x) => logs.push(x));
  l.contar("A", "x");
  assert.equal(logs.length, 1, "primeira recusa sai logo");
  agora = 1_000;
  for (let i = 0; i < 50; i += 1) l.contar(`C${i}`, "y");
  assert.equal(logs.length, 1, "no máximo uma linha por minuto");
  assert.equal(l.pendentes().size, 4, "dimensões limitadas (3 + OUTROS)");
  assert.equal(l.pendentes().get("OUTROS"), 47, "excedente agregado numa chave só");
  agora = 61_000;
  l.descarregar();
  assert.equal(logs.length, 2, "temporizador descarrega sem nova recusa");
  assert.match(logs[1], /OUTROS=47/);
  assert.equal(l.pendentes().size, 0);
  l.descarregar();
  assert.equal(logs.length, 2, "nada pendente, nada emitido");
  assert.equal(rotuloCliente("https://claude.ai/oauth/x.json", ENV_OK), "claude.ai");
  assert.match(rotuloCliente("não é url <script>", ENV_OK), /^h[0-9a-f]{8}$/);
});

// ---------------------------------------------------------------- rodada 3 da revisão (achados 1 e 3)

test("rodada 3, achado 3: método não atendido e erro do fluxo do corpo também são recusas contadas, com resposta sanitizada", async () => {
  const { deps, repo } = montar();
  const antes = deps.limites.totalContadas();
  const post = await atenderAutorizacao(new Request(autorizar().url, { method: "POST", body: "x" }), deps);
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
  const get = await atenderToken(new Request(`${BASE}/t`), deps);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  const quebrado = new ReadableStream<Uint8Array>({ pull(ctrl) { ctrl.error(new Error("conexão caída com segredo kmr_xyz")); } });
  const erro = await atenderToken(new Request(`${BASE}/t`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: quebrado, duplex: "half" } as RequestInit), deps);
  assert.equal(erro.status, 400);
  assert.deepEqual(await erro.json(), { error: "invalid_request" }, "sem detalhe do erro");
  assert.equal(deps.limites.totalContadas() - antes, 3);
  assert.equal(deps.limites.leiturasEmCurso(), 0, "vaga devolvida mesmo com erro do fluxo");
  assert.equal(repo.auditoria.length, 0);
});

test("rodada 3, achado 1: prazo total do pedido OAuth e expurgo fora do caminho da resposta (um por vez)", async () => {
  const lento = montar({ limites: { prazoTotalMs: 100 } });
  lento.repo.clienteEmCache = () => new Promise(() => undefined); // banco preso
  const inicio = Date.now();
  const r = await atenderAutorizacao(autorizar(), lento.deps);
  assert.equal(r.status, 503);
  assert.ok(Date.now() - inicio < 2000, "terminou pelo prazo total");
  assert.equal(lento.deps.limites.totalContadas(), 1, "AUTHORIZE_PRAZO contado");

  const { deps, repo } = montar({ limites: { expurgoIntervaloMs: 0 } });
  let expurgos = 0;
  repo.expurgarExpirados = () => { expurgos += 1; return new Promise(() => undefined); }; // expurgo preso
  assert.equal((await atenderAutorizacao(autorizar(), deps)).status, 302, "a resposta não espera o expurgo");
  assert.equal((await atenderAutorizacao(autorizar(), deps)).status, 302);
  assert.equal(expurgos, 1, "no máximo um expurgo em curso por instância");
});

// ---------------------------------------------------------------- rodada 4 da revisão (achados 3 e 6)

test("rodada 4, achado 3: prazo total PROPAGADO — depois do limite nenhuma etapa nova começa (sem escrita após o 503)", async () => {
  // Cada etapa do repositório demora 60 ms; orçamento de etapa 50 ms e prazo total 150 ms: ler e guardar o cliente cabem, criar o pedido (em ~120 ms) não.
  const { deps, repo } = montar({ limites: { prazoTotalMs: 150, etapaBancoMaxMs: 50, etapaCimdMaxMs: 50 } });
  const chamadas: string[] = [];
  const lento = <T>(nome: string, f: () => Promise<T>) => new Promise<T>((ok, falha) => setTimeout(() => { chamadas.push(nome); f().then(ok, falha); }, 60));
  const cliente = repo.clienteEmCache.bind(repo), guardar = repo.guardarCliente.bind(repo), criar = repo.criarPedidoNoTeto.bind(repo);
  repo.clienteEmCache = (id) => lento("clienteEmCache", () => cliente(id));
  repo.guardarCliente = (c) => lento("guardarCliente", () => guardar(c));
  repo.criarPedidoNoTeto = (h, p, t) => lento("criarPedidoNoTeto", () => criar(h, p, t));
  const r = await atenderAutorizacao(autorizar(), deps);
  assert.equal(r.status, 503);
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(repo.pedidos.size, 0, "nenhum pedido criado depois da resposta de falha");
  assert.ok(!chamadas.includes("criarPedidoNoTeto"), `etapa mutante não iniciada (${chamadas.join(",")})`);
  assert.equal(deps.limites.totalContadas(), 1, "uma recusa contada (AUTHORIZE_PRAZO)");

  // Controle: com prazo folgado, o mesmo fluxo lento conclui.
  const folgado = montar({ limites: { prazoTotalMs: 5000, etapaBancoMaxMs: 100, etapaCimdMaxMs: 100 } });
  const c2 = folgado.repo.clienteEmCache.bind(folgado.repo);
  folgado.repo.clienteEmCache = (id) => lento("x", () => c2(id));
  assert.equal((await atenderAutorizacao(autorizar(), folgado.deps)).status, 302);
});

test("rodada 4, achado 3: no token, o prazo total começa na CHEGADA (inclui a leitura do corpo)", async () => {
  const { deps } = montar({ limites: { prazoTotalMs: 120, corpoPrazoMs: 5000 } });
  const pendurado = new ReadableStream<Uint8Array>({ start(ctrl) { ctrl.enqueue(new Uint8Array([97])); } });
  const inicio = Date.now();
  const r = await atenderToken(new Request(`${BASE}/t`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: pendurado, duplex: "half" } as RequestInit), deps);
  assert.equal(r.status, 408);
  assert.ok(Date.now() - inicio < 1000, "a leitura respeitou o prazo total, não os 5 s do corpo");
});

test("rodada 4, achado 6: memória retém pedido consumido por 1 h, como o PostgreSQL", async () => {
  const { repo, agora } = montar();
  const p = { clientId: CHATGPT, clienteNome: "ChatGPT", redirectUri: CALLBACK, state: null, codeChallenge: "A".repeat(43), escopos: ["agenda:read" as const], recurso: ENV_OK.MCP_PUBLIC_URL, expiraEm: new Date(agora.t + 600_000) };
  await repo.criarPedidoNoTeto("h1", p, 10);
  await repo.consumirPedido("h1");
  assert.equal((await repo.expurgarExpirados()).pedidos, 0, "consumido há menos de 1 h fica");
  agora.t += 3_600_001;
  assert.equal((await repo.expurgarExpirados()).pedidos, 1, "consumido há mais de 1 h sai");
});

test("rodada 4, achado 5: JSON administrativo com teto e prazo (lerJsonLimitado)", async () => {
  const { lerJsonLimitado } = await import("../mcp/corpo.ts");
  assert.deepEqual(await lerJsonLimitado(new Request(`${BASE}/x`, { method: "POST", body: '{"a":1}' }), 4096, 1000), { ok: true, valor: { a: 1 } });
  assert.deepEqual(await lerJsonLimitado(new Request(`${BASE}/x`, { method: "POST", body: "x".repeat(5000) }), 4096, 1000), { ok: false, status: 413 });
  assert.deepEqual(await lerJsonLimitado(new Request(`${BASE}/x`, { method: "POST", body: "{quebrado" }), 4096, 1000), { ok: false, status: 400 });
  const pendurado = new ReadableStream<Uint8Array>({ start(ctrl) { ctrl.enqueue(new Uint8Array([123])); } });
  assert.deepEqual(await lerJsonLimitado(new Request(`${BASE}/x`, { method: "POST", body: pendurado, duplex: "half" } as RequestInit), 4096, 60), { ok: false, status: 408 });
});

test("rodada 5 (P3): CIMD ocupado/tempo e falha interna no token são indisponibilidade (503), não culpa do aplicativo", async () => {
  const { CimdRecusado } = await import("./cimd.ts");
  const { CanalOcupado } = await import("../mcp/admissao.ts");
  const ocupado = montar();
  ocupado.deps.oauth.buscarCimd = async () => { throw new CimdRecusado("OCUPADO"); };
  const r = await atenderAutorizacao(autorizar(), ocupado.deps);
  assert.equal(r.status, 503, "busca CIMD ocupada não vira 'aplicativo não habilitado'");
  assert.match(await r.text(), /Tente de novo/);
  const definitivo = montar();
  assert.equal((await atenderAutorizacao(autorizar({ client_id: "https://evil.example/c.json" }), definitivo.deps)).status, 400, "controle: recusa definitiva continua 400");

  const banco = montar();
  banco.repo.lerAtualizacao = async () => { throw new CanalOcupado(); };
  const t = await atenderToken(new Request(`${BASE}/t`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `grant_type=refresh_token&client_id=${encodeURIComponent(CHATGPT)}&refresh_token=kmr_${"x".repeat(43)}` }), banco.deps);
  assert.equal(t.status, 503);
  assert.deepEqual(await t.json(), { error: "temporarily_unavailable" });
  assert.equal(banco.deps.limites.totalContadas(), 1);
});
