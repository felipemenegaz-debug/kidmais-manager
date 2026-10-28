import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { RepositorioOAuthMemoria } from "../oauth/memoria-teste.ts";
import type { BuscaDocumento } from "../oauth/cimd.ts";
import { conexoesDaPessoa } from "../oauth/conexoes.ts";
import { LimitadorPublicoOAuth, atenderAutorizacao, atenderToken } from "../oauth/rotas.ts";
import { concluirConsentimento, metadadosRecurso, metadadosServidor, type DependenciasConsentimento } from "../oauth/servico.ts";
import { instalarDetector } from "./detector-rede-teste.ts";
import { A, B, ENV_OK, UA, UB, deps as depsFerramentas, mundo, type Mundo } from "./apoio-mcp.test.ts";
import { LimitadorMcp } from "./limites.ts";
import { criarTransporteMcp } from "./servidor.ts";

/**
 * Protocolo LOCAL em loopback (A1, A2, A3, A4, A5 sem PostgreSQL): servidor HTTP real com o transporte MCP do SDK oficial,
 * descoberta e OAuth (CIMD simulado, sem rede externa), consentimento pela função do servidor, cliente MCP oficial.
 * Persistência aqui é a de MEMÓRIA (só teste): concorrência entre processos e durabilidade ficam para a suíte PostgreSQL.
 */
const CHATGPT = "https://chatgpt.com/oauth/client.json";
const CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect";

type Ambiente = {
  url: string;
  env: Record<string, string | undefined>;
  repo: RepositorioOAuthMemoria;
  mundo: Mundo;
  relogio: { agora: Date };
  servidor: Server;
  buscas: string[];
  limitador: LimitadorMcp;
  atender: (request: Request) => Promise<Response>;
};

const cimdFalso = (buscas: string[]): BuscaDocumento => async (url) => {
  buscas.push(url.href);
  if (url.href !== CHATGPT) return { status: 404, tipo: "application/json", corpo: "{}" };
  // Mesmo formato do documento REAL do ChatGPT (27/10/2026): declara private_key_jwt e lista none entre os suportados.
  return { status: 200, tipo: "application/json", corpo: JSON.stringify({ client_id: CHATGPT, client_name: "ChatGPT", redirect_uris: [CALLBACK],
    token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: ["none", "private_key_jwt"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) };
};

async function subir(ajuste: { agendaExtra?: Parameters<typeof depsFerramentas>[3] } = {}): Promise<Ambiente> {
  // A biblioteca OAuth calcula vencimentos pelo relógio real: o relógio do teste parte dele e só avança.
  const relogio = { agora: new Date() };
  const repo = new RepositorioOAuthMemoria(() => relogio.agora);
  const criado = new Date("2026-01-01T00:00:00Z");
  repo.usuarios.set(UA, { ativo: true, papel: "ADMINISTRATIVO", senhaAlteradaEm: criado });
  repo.usuarios.set(UB, { ativo: true, papel: "REPRESENTANTE_AUTORIZADO", senhaAlteradaEm: criado });
  repo.empresas.set(A, "Buffet A Sintético");
  repo.empresas.set(B, "Buffet B Sintético");
  const m = mundo();
  const buscas: string[] = [];
  const env: Record<string, string | undefined> = { ...ENV_OK };
  const amb = { env, repo, mundo: m, relogio, buscas } as Ambiente;
  const oauth = { env, repo, buscarCimd: cimdFalso(buscas), agora: () => relogio.agora };
  const limitador = new LimitadorMcp();
  const rotas = { oauth, limites: new LimitadorPublicoOAuth(), origem: () => null };
  const ferramentas = depsFerramentas(m, env, [], {
    async concessaoVigente(_tx, p) { return (await repo.listarConcessoes(p.usuarioId)).some((c) => c.id === p.concessaoId && !c.revogadaEm); },
    ...ajuste.agendaExtra,
  });
  ferramentas.agora = () => relogio.agora;
  const atender = criarTransporteMcp({ oauth, ferramentas, limitador, prazoCorpoMs: 200 });
  amb.atender = atender;
  const servidor = createServer(async (req, res) => {
    const partes: Buffer[] = [];
    for await (const c of req) partes.push(c as Buffer);
    const corpo = partes.length ? Buffer.concat(partes) : undefined;
    const url = new URL(req.url ?? "/", amb.url);
    const pedido = new Request(url, { method: req.method, headers: req.headers as Record<string, string>, body: req.method === "GET" || req.method === "HEAD" ? undefined : corpo });
    let resposta: Response;
    if (url.pathname === "/api/mcp") resposta = await atender(pedido);
    else if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) resposta = Response.json(metadadosRecurso(env));
    else if (url.pathname === "/.well-known/oauth-authorization-server") resposta = Response.json(metadadosServidor(env));
    // Mesmas bordas das rotas reais (canal, limites, teto de pedidos, corpo limitado).
    else if (url.pathname === "/api/mcp/oauth/authorize") resposta = await atenderAutorizacao(pedido, rotas);
    else if (url.pathname === "/api/mcp/oauth/token") resposta = await atenderToken(pedido, rotas);
    else resposta = new Response("not found", { status: 404 });
    res.writeHead(resposta.status, Object.fromEntries(resposta.headers));
    res.end(Buffer.from(await resposta.arrayBuffer()));
  });
  await new Promise<void>((ok) => servidor.listen(0, "127.0.0.1", ok));
  const porta = (servidor.address() as AddressInfo).port;
  amb.url = `http://127.0.0.1:${porta}`;
  env.MCP_PUBLIC_URL = `${amb.url}/api/mcp`;
  amb.servidor = servidor;
  amb.limitador = limitador;
  return amb;
}

const descer = (a: Ambiente) => new Promise<void>((ok) => a.servidor.close(() => ok()));

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function consentimentoDeps(a: Ambiente): DependenciasConsentimento {
  const f = depsFerramentas(a.mundo, a.env);
  return { env: a.env, repo: a.repo, buscarCimd: cimdFalso(a.buscas), agora: () => a.relogio.agora, withTenantTransaction: f.withTenantTransaction, leituraComercialPermitida: f.leituraComercialPermitida };
}

async function autorizar(a: Ambiente, extra: Record<string, string> = {}, omitir: string[] = []) {
  const p = pkce();
  const q = new URLSearchParams({
    response_type: "code", client_id: CHATGPT, redirect_uri: CALLBACK, scope: "agenda:read financeiro:read conhecimento:read", state: "st-123",
    code_challenge: p.challenge, code_challenge_method: "S256", resource: `${a.url}/api/mcp`, ...extra,
  });
  for (const o of omitir) q.delete(o);
  const r = await fetch(`${a.url}/api/mcp/oauth/authorize?${q}`, { redirect: "manual" });
  return { r, p, location: r.headers.get("location") };
}

async function conectar(a: Ambiente, opcoes: { usuario?: string; empresa?: string; escopos?: string[] } = {}) {
  const { location, p } = await autorizar(a);
  assert.ok(location?.includes("/admin/conexoes-ia/autorizar?pedido="), String(location));
  const pedido = new URL(location!).searchParams.get("pedido")!;
  const usuario = opcoes.usuario ?? UA;
  const { destino } = await concluirConsentimento(
    { pedido, empresaId: opcoes.empresa ?? A, escopos: opcoes.escopos ?? ["agenda:read", "financeiro:read", "conhecimento:read"], decisao: "PERMITIR" },
    { usuario_id: usuario, papel: "ADMINISTRATIVO" }, consentimentoDeps(a));
  const volta = new URL(destino);
  assert.equal(volta.origin + volta.pathname, CALLBACK);
  assert.equal(volta.searchParams.get("state"), "st-123");
  assert.equal(volta.searchParams.get("iss"), a.url, "RFC 9207 iss");
  const code = volta.searchParams.get("code")!;
  const token = await trocar(a, { grant_type: "authorization_code", code, code_verifier: p.verifier, redirect_uri: CALLBACK, client_id: CHATGPT, resource: `${a.url}/api/mcp` });
  assert.equal(token.status, 200, JSON.stringify(token.corpo));
  return { code, verifier: p.verifier, acesso: token.corpo.access_token as string, atualizacao: token.corpo.refresh_token as string, corpo: token.corpo };
}

async function trocar(a: Ambiente, campos: Record<string, string>) {
  const r = await fetch(`${a.url}/api/mcp/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(campos) });
  return { status: r.status, corpo: await r.json() as Record<string, unknown> };
}

async function clienteMcp(a: Ambiente, token: string) {
  const c = new Client({ name: "teste-loopback", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${a.url}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}

async function postMcp(a: Ambiente, token: string | null, corpo: unknown, headers: Record<string, string> = {}) {
  return fetch(`${a.url}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(corpo),
  });
}

const LISTAR = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

test("descoberta: metadados RFC 9728/8414 e 401 com resource_metadata", async () => {
  const a = await subir();
  try {
    const pr = await (await fetch(`${a.url}/.well-known/oauth-protected-resource/api/mcp`)).json() as Record<string, unknown>;
    assert.equal(pr.resource, `${a.url}/api/mcp`);
    assert.deepEqual(pr.authorization_servers, [a.url]);
    const as = await (await fetch(`${a.url}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
    assert.equal(as.client_id_metadata_document_supported, true);
    assert.equal(as.registration_endpoint, undefined, "DCR não oferecido no piloto");
    const r = await postMcp(a, null, LISTAR);
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/api\/mcp"/);
  } finally {
    await descer(a);
  }
});

test("A1: cliente MCP oficial inicializa, lista exatamente as 4 ferramentas e chama cada uma; nome adivinhado não existe (A8)", async () => {
  const a = await subir();
  const det = instalarDetector();
  try {
    const t = await conectar(a);
    const c = await clienteMcp(a, t.acesso);
    assert.equal(c.getServerVersion()?.name, "kidmais-manager");
    const { tools } = await c.listTools();
    assert.deepEqual(tools.map((x) => x.name).sort(), ["kidmais_buscar_conhecimento", "kidmais_consultar_agenda", "kidmais_consultar_recebiveis_resumo", "kidmais_obter_trecho"]);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties, false, `${tool.name} entrada estrita`);
      assert.ok(tool.outputSchema, `${tool.name} saída declarada`);
    }
    const agenda = await c.callTool({ name: "kidmais_consultar_agenda", arguments: { dia: "hoje" } });
    assert.equal(agenda.isError, undefined);
    assert.equal((agenda.structuredContent as { totalFestas: number }).totalFestas, 2);
    const rec = await c.callTool({ name: "kidmais_consultar_recebiveis_resumo", arguments: {} });
    assert.equal((rec.structuredContent as { emAberto: { totalCentavos: number } }).emAberto.totalCentavos, 325050);
    const busca = await c.callTool({ name: "kidmais_buscar_conhecimento", arguments: { consulta: "onde vejo contas a receber" } });
    const ref = (busca.structuredContent as { resultados: Array<{ referencia: string }> }).resultados[0].referencia;
    const trecho = await c.callTool({ name: "kidmais_obter_trecho", arguments: { referencia: ref } });
    assert.equal((trecho.structuredContent as { encontrado: boolean }).encontrado, true);
    for (const nome of ["kidmais_executar_sql", "sql", "shell", "kidmais_enviar_whatsapp", "kidmais_criar_cobranca"]) {
      await assert.rejects(c.callTool({ name: nome, arguments: {} }), /not found/i, nome);
    }
    const invalido = await c.callTool({ name: "kidmais_consultar_agenda", arguments: { dia: "ontem" } }).catch((e: Error) => e);
    assert.ok(invalido instanceof Error || (invalido as { isError?: boolean }).isError, "schema recusa argumento fora do enum");
    await c.close();
    assert.deepEqual(det.destinos, [], "zero conexões fora do loopback (A2)");
    assert.equal(a.env.OPENAI_API_KEY, undefined);
    assert.equal(a.env.AI_COPILOTO_MODEL_ENABLED, undefined);
  } finally {
    det.restaurar();
    await descer(a);
  }
});

test("A2 controle positivo: o detector acusa e bloqueia uma chamada proibida injetada na ferramenta", async () => {
  const a = await subir({
    agendaExtra: {
      async agenda() {
        await fetch("https://api.openai.com/v1/responses", { method: "POST", body: "{}" });
        return [];
      },
    },
  });
  const det = instalarDetector();
  try {
    const t = await conectar(a);
    const c = await clienteMcp(a, t.acesso);
    const r = await c.callTool({ name: "kidmais_consultar_agenda", arguments: {} });
    assert.equal(r.isError, true, "falha fechada, sem dados");
    assert.deepEqual(det.destinos, ["fetch:api.openai.com"], "detector registrou a chamada proibida");
    await c.close();
  } finally {
    det.restaurar();
    await descer(a);
  }
});

test("transporte: sem sessão, GET/DELETE 405, Origin alheio 403, corpo grande 413, tipo errado 415, sem cache", async () => {
  const a = await subir();
  try {
    const t = await conectar(a);
    assert.equal((await fetch(`${a.url}/api/mcp`, { headers: { authorization: `Bearer ${t.acesso}` } })).status, 405);
    assert.equal((await fetch(`${a.url}/api/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${t.acesso}` } })).status, 405);
    assert.equal((await postMcp(a, t.acesso, LISTAR, { origin: "https://evil.example" })).status, 403);
    assert.equal((await postMcp(a, t.acesso, { ...LISTAR, params: { lixo: "x".repeat(70_000) } })).status, 413);
    assert.equal((await fetch(`${a.url}/api/mcp`, { method: "POST", headers: { authorization: `Bearer ${t.acesso}`, "content-type": "text/plain" }, body: "{}" })).status, 415);
    const ok = await postMcp(a, t.acesso, LISTAR);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.equal(ok.headers.get("mcp-session-id"), null, "stateless: sessão MCP não identifica ninguém");
    a.env.MCP_ENABLED = "false";
    assert.equal((await postMcp(a, t.acesso, LISTAR)).status, 503, "canal desligado recusa antes de autenticar");
  } finally {
    await descer(a);
  }
});

test("A5 autorização: cliente fora da lista, redirect divergente, sem PKCE, plain, resource errado e escopo desconhecido", async () => {
  const a = await subir();
  try {
    const desconhecido = await autorizar(a, { client_id: "https://evil.example/client.json" });
    assert.equal(desconhecido.r.status, 400);
    assert.equal(desconhecido.location, null, "nunca redireciona sem cliente conferido");
    assert.ok(!a.buscas.includes("https://evil.example/client.json"), "host fora da lista nem é buscado (SSRF)");
    const redirect = await autorizar(a, { redirect_uri: "https://evil.example/cb" });
    assert.equal(redirect.r.status, 400);
    assert.equal(redirect.location, null, "sem open redirect");
    for (const [extra, omitir, erro] of [
      [{}, ["code_challenge"], "invalid_request"],
      [{ code_challenge_method: "plain" }, [], "invalid_request"],
      [{ resource: "https://outro.example/api/mcp" }, [], "invalid_target"],
      [{}, ["resource"], "invalid_target"],
      [{ scope: "agenda:read admin:write" }, [], "invalid_scope"],
      [{ response_type: "token" }, [], "unsupported_response_type"],
    ] as Array<[Record<string, string>, string[], string]>) {
      const r = await autorizar(a, extra, omitir);
      assert.equal(r.r.status, 302, JSON.stringify(extra));
      const u = new URL(r.location!);
      assert.equal(u.origin + u.pathname, CALLBACK);
      assert.equal(u.searchParams.get("error"), erro);
      assert.equal(u.searchParams.get("iss"), a.url);
    }
    const duplicado = await fetch(`${a.url}/api/mcp/oauth/authorize?client_id=${encodeURIComponent(CHATGPT)}&client_id=x`, { redirect: "manual" });
    assert.equal(duplicado.status, 400);
  } finally {
    await descer(a);
  }
});

test("A5 consentimento: escopo não pedido recusado, empresa sem membership recusada, negar devolve access_denied, pedido de uso único", async () => {
  const a = await subir();
  try {
    const { location } = await autorizar(a, { scope: "agenda:read" });
    const pedido = new URL(location!).searchParams.get("pedido")!;
    const d = consentimentoDeps(a);
    await assert.rejects(concluirConsentimento({ pedido, empresaId: A, escopos: ["financeiro:read"], decisao: "PERMITIR" }, { usuario_id: UA, papel: "ADMINISTRATIVO" }, d), /permissão/);
    await assert.rejects(concluirConsentimento({ pedido, empresaId: A, escopos: [], decisao: "PERMITIR" }, { usuario_id: UA, papel: "ADMINISTRATIVO" }, d));
    await assert.rejects(concluirConsentimento({ pedido, empresaId: B, escopos: ["agenda:read"], decisao: "PERMITIR" }, { usuario_id: UA, papel: "ADMINISTRATIVO" }, d), /empresa autorizada/);
    a.env.MCP_TENANT_ALLOWLIST = B;
    await assert.rejects(concluirConsentimento({ pedido, empresaId: A, escopos: ["agenda:read"], decisao: "PERMITIR" }, { usuario_id: UA, papel: "ADMINISTRATIVO" }, d), /piloto/);
    a.env.MCP_TENANT_ALLOWLIST = ENV_OK.MCP_TENANT_ALLOWLIST;
    const negado = await concluirConsentimento({ pedido, empresaId: A, escopos: [], decisao: "NEGAR" }, { usuario_id: UA, papel: "ADMINISTRATIVO" }, d);
    assert.equal(new URL(negado.destino).searchParams.get("error"), "access_denied");
    await assert.rejects(concluirConsentimento({ pedido, empresaId: A, escopos: ["agenda:read"], decisao: "PERMITIR" }, { usuario_id: UA, papel: "ADMINISTRATIVO" }, d), /expirado/, "pedido já consumido");
    assert.equal(a.repo.concessoes.size, 0, "nenhuma concessão criada");
  } finally {
    await descer(a);
  }
});

test("A5 token: verifier errado queima o código (e reapresentar revoga); redirect divergente; resource errado; code replay revoga a concessão", async () => {
  const a = await subir();
  try {
    const codigo = async (escopo = "agenda:read") => {
      const { location, p } = await autorizar(a);
      const pedido = new URL(location!).searchParams.get("pedido")!;
      const { destino } = await concluirConsentimento({ pedido, empresaId: A, escopos: [escopo], decisao: "PERMITIR" }, { usuario_id: UA, papel: "ADMINISTRATIVO" }, consentimentoDeps(a));
      return { code: new URL(destino).searchParams.get("code")!, verifier: p.verifier };
    };
    const base = (code: string) => ({ grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: CHATGPT });
    // 1) verifier errado: a biblioteca consome o código ANTES do PKCE (anti força bruta); o verifier certo depois é reuso.
    const c1 = await codigo();
    assert.equal((await trocar(a, { ...base(c1.code), code_verifier: pkce().verifier })).corpo.error, "invalid_grant");
    assert.equal((await trocar(a, { ...base(c1.code), code_verifier: c1.verifier })).corpo.error, "invalid_grant");
    assert.ok(a.repo.auditoria.some((e) => e.evento === "REUSO_DETECTADO"));
    // 2) redirect divergente na troca
    const c2 = await codigo();
    assert.equal((await trocar(a, { ...base(c2.code), code_verifier: c2.verifier, redirect_uri: "https://chatgpt.com/outro" })).status, 400);
    // 3) resource errado é recusado antes de consumir; depois a troca correta funciona; replay revoga os tokens emitidos
    const c3 = await codigo();
    assert.equal((await trocar(a, { ...base(c3.code), code_verifier: c3.verifier, resource: "https://outro.example/api/mcp" })).corpo.error, "invalid_target");
    assert.equal((await trocar(a, { ...base(c3.code), code_verifier: "curto" })).corpo.error, "invalid_request", "verifier fora do formato");
    const ok = await trocar(a, { ...base(c3.code), code_verifier: c3.verifier });
    assert.equal(ok.status, 200, JSON.stringify(ok.corpo));
    assert.equal(ok.corpo.token_type, "Bearer");
    assert.equal(ok.corpo.scope, "agenda:read");
    assert.ok((ok.corpo.expires_in as number) <= 3600);
    assert.equal((await postMcp(a, ok.corpo.access_token as string, LISTAR)).status, 200);
    const replay = await trocar(a, { ...base(c3.code), code_verifier: c3.verifier });
    assert.equal(replay.corpo.error, "invalid_grant");
    assert.equal((await postMcp(a, ok.corpo.access_token as string, LISTAR)).status, 401, "replay revogou os tokens já emitidos");
    assert.ok(a.repo.auditoria.some((e) => e.evento === "REUSO_DETECTADO" && e.codigo === "CODIGO_REAPRESENTADO"));
  } finally {
    await descer(a);
  }
});

test("A5 refresh rotativo: novo par a cada uso; reapresentar o antigo revoga a concessão", async () => {
  const a = await subir();
  try {
    const t = await conectar(a);
    const r1 = await trocar(a, { grant_type: "refresh_token", refresh_token: t.atualizacao, client_id: CHATGPT });
    assert.equal(r1.status, 200);
    assert.notEqual(r1.corpo.refresh_token, t.atualizacao);
    assert.equal((await trocar(a, { grant_type: "refresh_token", refresh_token: r1.corpo.refresh_token as string, client_id: CHATGPT, scope: "agenda:read admin:write" })).corpo.error, "invalid_scope", "refresh não amplia escopo");
    assert.equal((await postMcp(a, r1.corpo.access_token as string, LISTAR)).status, 200);
    const reuso = await trocar(a, { grant_type: "refresh_token", refresh_token: t.atualizacao, client_id: CHATGPT });
    assert.equal(reuso.corpo.error, "invalid_grant");
    assert.equal((await postMcp(a, r1.corpo.access_token as string, LISTAR)).status, 401, "família revogada");
    assert.equal((await trocar(a, { grant_type: "refresh_token", refresh_token: r1.corpo.refresh_token as string, client_id: CHATGPT })).corpo.error, "invalid_grant");
  } finally {
    await descer(a);
  }
});

test("achado 4: refresh GIRADO reapresentado depois de VENCIDO ainda é reuso e revoga a família; vencido nunca girado só é inválido", async () => {
  const a = await subir();
  try {
    const t = await conectar(a);
    const r1 = await trocar(a, { grant_type: "refresh_token", refresh_token: t.atualizacao, client_id: CHATGPT });
    assert.equal(r1.status, 200);
    a.relogio.agora = new Date(a.relogio.agora.getTime() + 31 * 86_400_000); // o refresh original já venceu
    const reuso = await trocar(a, { grant_type: "refresh_token", refresh_token: t.atualizacao, client_id: CHATGPT });
    assert.equal(reuso.corpo.error, "invalid_grant");
    const conc = [...a.repo.concessoes.values()].find((c) => c.usuarioId === UA)!;
    assert.equal(conc.motivo, "REUSO", "família revogada mesmo com o token girado vencido");
    assert.ok(a.repo.auditoria.some((e) => e.evento === "REUSO_DETECTADO" && e.codigo === "REFRESH_REAPRESENTADO"));

    // Controle: refresh vencido que NUNCA foi girado é só inválido (expiração natural, não reuso).
    const b = await subir();
    try {
      const u = await conectar(b);
      b.relogio.agora = new Date(b.relogio.agora.getTime() + 31 * 86_400_000);
      assert.equal((await trocar(b, { grant_type: "refresh_token", refresh_token: u.atualizacao, client_id: CHATGPT })).corpo.error, "invalid_grant");
      assert.equal([...b.repo.concessoes.values()].find((c) => c.usuarioId === UA)!.revogadaEm, null, "não revoga por vencimento natural");
    } finally {
      await descer(b);
    }
  } finally {
    await descer(a);
  }
});

test("achado 3: renovação limitada por concessão ANTES de girar (429 sem consumir o refresh) e retenção limitada na gravação", async () => {
  const a = await subir();
  try {
    const t = await conectar(a); // 1 emissão
    let atual = t.atualizacao;
    const girados: string[] = [t.atualizacao];
    for (let i = 0; i < 29; i += 1) {
      const r = await trocar(a, { grant_type: "refresh_token", refresh_token: atual, client_id: CHATGPT });
      assert.equal(r.status, 200, `renovação ${i}`);
      atual = r.corpo.refresh_token as string;
      girados.push(atual);
    }
    const barrado = await trocar(a, { grant_type: "refresh_token", refresh_token: atual, client_id: CHATGPT });
    assert.equal(barrado.status, 429);
    assert.equal(barrado.corpo.error, "temporarily_unavailable");
    const conc = [...a.repo.concessoes.values()].find((c) => c.usuarioId === UA)!;
    assert.equal(conc.revogadaEm, null, "o limite não revoga nada");
    const doConc = () => [...a.repo.tokens.values()].filter((x) => x.concessaoId === conc.id);
    assert.ok(doConc().filter((x) => x.tipo === "ATUALIZACAO" && x.revogadoEm).length <= 20, "só os últimos 20 girados ficam guardados");
    assert.ok(doConc().length <= 30 + 20 + 1, `linhas por concessão limitadas (${doConc().length})`);

    a.relogio.agora = new Date(a.relogio.agora.getTime() + 61 * 60_000);
    const depois = await trocar(a, { grant_type: "refresh_token", refresh_token: atual, client_id: CHATGPT });
    assert.equal(depois.status, 200, "o mesmo refresh continua valendo depois da janela");

    // Janela de detecção declarada: um girado que já saiu da retenção não é mais reconhecido (só inválido).
    const antigo = await trocar(a, { grant_type: "refresh_token", refresh_token: girados[0], client_id: CHATGPT });
    assert.equal(antigo.corpo.error, "invalid_grant");
    assert.equal(conc.revogadaEm, null, "fora da janela de detecção: não revoga (limitação documentada)");
    const recente = await trocar(a, { grant_type: "refresh_token", refresh_token: girados[girados.length - 2], client_id: CHATGPT });
    assert.equal(recente.corpo.error, "invalid_grant");
    assert.equal(conc.motivo, "REUSO", "dentro da janela: reuso revoga");
  } finally {
    await descer(a);
  }
});

test("rodada 4, achado 2: corpo pendurado ocupa só a vaga da PRÓPRIA concessão (≤ 2), termina pelo prazo e consome a taxa", async () => {
  const a = await subir();
  try {
    const t = await conectar(a);
    const tb = await conectar(a, { usuario: UB, empresa: B });
    const pendurado = () => new ReadableStream<Uint8Array>({ start(ctrl) { ctrl.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",')); } });
    const pedido = (token: string) => new Request(`${a.url}/api/mcp`, {
      method: "POST", body: pendurado(), duplex: "half",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    } as RequestInit);
    const lentos = [a.atender(pedido(t.acesso)), a.atender(pedido(t.acesso))];
    await new Promise((ok) => setTimeout(ok, 30));
    assert.equal(a.limitador.leituras.quantas(), 2, "duas leituras em curso");
    assert.equal((await a.atender(pedido(t.acesso))).status, 429, "a terceira da MESMA concessão é recusada antes de ler (sem ocupar leitura global)");
    assert.equal(a.limitador.leituras.quantas(), 2);
    const cb = await clienteMcp(a, tb.acesso);
    const r = await cb.callTool({ name: "kidmais_consultar_agenda", arguments: { dia: "hoje" } });
    assert.notEqual(r.isError, true, "outra empresa segue atendida");
    await cb.close();
    assert.deepEqual((await Promise.all(lentos)).map((x) => x.status), [408, 408]);
    assert.equal(a.limitador.leituras.quantas(), 0, "leituras devolvidas");
    const ca = await clienteMcp(a, t.acesso);
    assert.notEqual((await ca.callTool({ name: "kidmais_consultar_agenda", arguments: { dia: "hoje" } })).isError, true, "a concessão volta a ser atendida");
    await ca.close();
  } finally {
    await descer(a);
  }
});

test("rodada 4, achado 1: Bearer inventado é admitido por taxa e por vagas ANTES do banco", async () => {
  const a = await subir();
  try {
    let consultas = 0;
    const original = a.repo.verificarAcesso.bind(a.repo);
    a.repo.verificarAcesso = async (h) => { consultas += 1; return original(h); };
    const falso = () => a.atender(new Request(`${a.url}/api/mcp`, {
      method: "POST", body: "{}", headers: { authorization: `Bearer kma_${randomBytes(32).toString("base64url")}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    }));
    const limite = 1200;
    let recusados = 0;
    for (let i = 0; i < limite + 50; i += 1) if ((await falso()).status === 429) recusados += 1;
    assert.equal(recusados, 50, "acima da taxa global de autenticações: 429");
    assert.equal(consultas, limite, "nenhuma consulta ao banco acima da taxa");
  } finally {
    await descer(a);
  }
});

test("rodada 4, achado 1: verificações de token simultâneas são limitadas antes do banco (sem fila)", async () => {
  const a = await subir();
  try {
    let consultas = 0;
    const soltar: Array<() => void> = [];
    a.repo.verificarAcesso = () => { consultas += 1; return new Promise((ok) => { soltar.push(() => ok(null)); }); };
    const falso = () => a.atender(new Request(`${a.url}/api/mcp`, {
      method: "POST", body: "{}", headers: { authorization: `Bearer kma_${randomBytes(32).toString("base64url")}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    }));
    const presos = Array.from({ length: 8 }, () => falso());
    await new Promise((ok) => setTimeout(ok, 20));
    assert.equal((await falso()).status, 503, "nona verificação simultânea recusada sem esperar");
    assert.equal(consultas, 8, "só 8 chegaram ao banco");
    for (const s of soltar) s();
    assert.deepEqual([...new Set((await Promise.all(presos)).map((r) => r.status))], [401]);
    assert.equal(a.limitador.autenticacoes.quantas(), 0);
  } finally {
    await descer(a);
  }
});

test("A5 refresh com escopo reduzido: o novo acesso vale SÓ o escopo reduzido, também nas renovações seguintes (revisão P1-1)", async () => {
  const a = await subir();
  try {
    const t = await conectar(a);
    const reduzido = await trocar(a, { grant_type: "refresh_token", refresh_token: t.atualizacao, client_id: CHATGPT, scope: "agenda:read" });
    assert.equal(reduzido.status, 200);
    assert.equal(reduzido.corpo.scope, "agenda:read");
    const c = await clienteMcp(a, reduzido.corpo.access_token as string);
    assert.equal((await c.callTool({ name: "kidmais_consultar_agenda", arguments: {} })).isError, undefined, "escopo mantido funciona");
    for (const nome of ["kidmais_consultar_recebiveis_resumo", "kidmais_buscar_conhecimento"]) {
      const r = await c.callTool({ name: nome, arguments: nome === "kidmais_buscar_conhecimento" ? { consulta: "contas a receber" } : {} });
      assert.equal(r.isError, true, `${nome} fora do escopo reduzido`);
      assert.equal(r.structuredContent, undefined);
    }
    await c.close();
    // Renovação seguinte sem `scope`: herda o escopo do token apresentado (reduzido), não o da concessão.
    const seguinte = await trocar(a, { grant_type: "refresh_token", refresh_token: reduzido.corpo.refresh_token as string, client_id: CHATGPT });
    assert.equal(seguinte.status, 200);
    assert.equal(seguinte.corpo.scope, "agenda:read");
    const c2 = await clienteMcp(a, seguinte.corpo.access_token as string);
    assert.equal((await c2.callTool({ name: "kidmais_consultar_recebiveis_resumo", arguments: {} })).isError, true);
    await c2.close();
    // Reampliar depois de reduzir é recusado.
    const ampliar = await trocar(a, { grant_type: "refresh_token", refresh_token: seguinte.corpo.refresh_token as string, client_id: CHATGPT, scope: "agenda:read financeiro:read" });
    assert.equal(ampliar.corpo.error, "invalid_scope");
  } finally {
    await descer(a);
  }
});

test("A4 token: inválido, expirado, revogado, audience errada, senha trocada e usuário inativo recusam com 401 e sem dados", async () => {
  const a = await subir();
  try {
    assert.equal((await postMcp(a, "kma_" + "x".repeat(43), LISTAR)).status, 401);
    assert.equal((await postMcp(a, "qualquer", LISTAR)).status, 401);
    const t = await conectar(a);
    const chamada = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "kidmais_consultar_agenda", arguments: {} } };
    // audience: o mesmo token apresentado a outro recurso configurado
    const original = a.env.MCP_PUBLIC_URL;
    a.env.MCP_PUBLIC_URL = `${a.url}/outro/mcp`;
    assert.equal((await postMcp(a, t.acesso, chamada)).status, 401, "resource da concessão diferente do recurso atual");
    a.env.MCP_PUBLIC_URL = original;
    // expirado
    const base = a.relogio.agora;
    a.relogio.agora = new Date(base.getTime() + 3601_000);
    assert.equal((await postMcp(a, t.acesso, chamada)).status, 401);
    a.relogio.agora = base;
    // senha trocada depois da concessão
    a.repo.usuarios.get(UA)!.senhaAlteradaEm = new Date(base.getTime() + 60_000);
    assert.equal((await postMcp(a, t.acesso, chamada)).status, 401);
    a.repo.usuarios.get(UA)!.senhaAlteradaEm = new Date("2026-01-01T00:00:00Z");
    // usuário inativo
    a.repo.usuarios.get(UA)!.ativo = false;
    assert.equal((await postMcp(a, t.acesso, chamada)).status, 401);
    a.repo.usuarios.get(UA)!.ativo = true;
    assert.equal((await postMcp(a, t.acesso, chamada)).status, 200, "controle positivo");
    // revogação persistida: sem cache de autorização
    const id = [...a.repo.concessoes.keys()][0];
    assert.equal(await a.repo.revogarConcessao(id, "USUARIO", UA), true);
    const depois = await postMcp(a, t.acesso, chamada);
    assert.equal(depois.status, 401);
    assert.doesNotMatch(await depois.text(), /festas|totalFestas/);
    assert.equal((await trocar(a, { grant_type: "refresh_token", refresh_token: t.atualizacao, client_id: CHATGPT })).corpo.error, "invalid_grant");
    assert.equal(await a.repo.revogarConcessao(id, "USUARIO", UA), false, "revogada não volta");
  } finally {
    await descer(a);
  }
});

test("A4 escopo insuficiente e papel removido sobre o protocolo: isError sem dados, com desafio de escopo", async () => {
  const a = await subir();
  try {
    const t = await conectar(a, { escopos: ["conhecimento:read"] });
    const c = await clienteMcp(a, t.acesso);
    const r = await c.callTool({ name: "kidmais_consultar_agenda", arguments: {} });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent, undefined);
    assert.match(JSON.stringify(r._meta), /insufficient_scope.*agenda:read/);
    a.mundo.membros.set(UA, [{ empresa: A, papel: "VISITANTE", ativa: true }]);
    const r2 = await c.callTool({ name: "kidmais_buscar_conhecimento", arguments: { consulta: "contas a receber" } });
    assert.equal(r2.isError, true);
    assert.match(JSON.stringify(r2.content), /ACESSO_NEGADO/);
    await c.close();
  } finally {
    await descer(a);
  }
});

test("A3 isolamento sobre o protocolo: A e B conectados ao mesmo servidor só veem a própria empresa", async () => {
  const a = await subir();
  try {
    const ta = await conectar(a);
    const tb = await conectar(a, { usuario: UB, empresa: B });
    const ca = await clienteMcp(a, ta.acesso);
    const cb = await clienteMcp(a, tb.acesso);
    const ra = JSON.stringify(await ca.callTool({ name: "kidmais_consultar_recebiveis_resumo", arguments: {} }));
    const rb = JSON.stringify(await cb.callTool({ name: "kidmais_consultar_recebiveis_resumo", arguments: {} }));
    assert.doesNotMatch(ra, /777777/);
    assert.match(rb, /777777/);
    const busca = await ca.callTool({ name: "kidmais_buscar_conhecimento", arguments: { consulta: "contas a receber" } });
    const ref = (busca.structuredContent as { resultados: Array<{ referencia: string }> }).resultados[0].referencia;
    const cruzado = await cb.callTool({ name: "kidmais_obter_trecho", arguments: { referencia: ref } });
    assert.equal((cruzado.structuredContent as { encontrado: boolean }).encontrado, false);
    const segredoB = await ca.callTool({ name: "kidmais_buscar_conhecimento", arguments: { consulta: "desconto secreto empresa B" } });
    assert.equal((segredoB.structuredContent as { semEvidencia: boolean }).semEvidencia, true);
    await ca.close();
    await cb.close();
  } finally {
    await descer(a);
  }
});

test("limites: taxa por concessão devolve 429 com Retry-After; concorrência liberada ao fim", async () => {
  const a = await subir();
  try {
    const t = await conectar(a);
    let ultimo = 0;
    for (let i = 0; i < 31; i += 1) ultimo = (await postMcp(a, t.acesso, LISTAR)).status;
    assert.equal(ultimo, 429);
    const r = await postMcp(a, t.acesso, LISTAR);
    assert.ok(Number(r.headers.get("retry-after")) >= 1);
  } finally {
    await descer(a);
  }
});

test("revisão P2-7/P3-10: canal desligado continua listando conexões (com a empresa) e permite revogar; religar não ressuscita", async () => {
  const a = await subir();
  try {
    const t = await conectar(a);
    await conectar(a, { usuario: UB, empresa: B });
    a.env.MCP_ENABLED = "false";
    const tela = await conexoesDaPessoa(a.env, a.repo, UA);
    assert.equal(tela.canal.ativo, false);
    assert.equal(tela.canal.urlServidor, null);
    assert.equal(tela.conexoes.length, 1, "só as da própria pessoa, mesmo desligado");
    assert.equal(tela.conexoes[0].empresaNome, "Buffet A Sintético");
    assert.equal(await a.repo.revogarConcessao(tela.conexoes[0].id, "USUARIO", UA), true);
    a.env.MCP_ENABLED = "true";
    assert.equal((await postMcp(a, t.acesso, LISTAR)).status, 401, "revogada com o canal desligado continua revogada");
    assert.equal((await conexoesDaPessoa(a.env, a.repo, UA)).conexoes[0].revogadaEm !== null, true);
    assert.equal(await a.repo.revogarConcessao((await conexoesDaPessoa(a.env, a.repo, UB)).conexoes[0].id, "USUARIO", UA), false, "não revoga conexão de outra pessoa");
  } finally {
    await descer(a);
  }
});
