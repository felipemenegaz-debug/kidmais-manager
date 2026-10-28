import assert from "node:assert/strict";
import test from "node:test";
import { instalarDetector } from "../mcp/detector-rede-teste.ts";
import { LIMITES_MCP } from "../mcp/config.ts";
import { LimitadorMcp } from "../mcp/limites.ts";
import { CimdRecusado, buscaHttpsFixada, carregarClienteCimd, enderecoPublico, urlCimdAceita, type BuscaDocumento } from "./cimd.ts";

/** A5 (registro do cliente e SSRF) e limites do canal, offline. */
const HOSTS = ["chatgpt.com", "claude.ai"];
const AGORA = new Date("2026-10-27T15:00:00Z");
const ID = "https://chatgpt.com/oauth/client.json";

test("client_id CIMD: só HTTPS, host da lista, sem porta, query, fragmento, credencial ou raiz", () => {
  assert.ok(urlCimdAceita(ID, HOSTS));
  for (const ruim of [
    "http://chatgpt.com/oauth/client.json", "https://chatgpt.com:8443/oauth/client.json", "https://chatgpt.com/oauth/client.json?x=1",
    "https://chatgpt.com/oauth/client.json#a", "https://u:p@chatgpt.com/oauth/client.json", "https://chatgpt.com/", "https://evil.example/client.json",
    "https://chatgpt.com.evil.example/client.json", "https://127.0.0.1/client.json", "https://CHATGPT.com/oauth/client.json", "client-estatico",
  ]) assert.equal(urlCimdAceita(ruim, HOSTS), null, ruim);
});

test("endereços: privados, loopback, link-local, CGNAT, multicast, documentação e mapeados recusados", () => {
  for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1",
    "::1", "::", "fc00::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "2001:db8::1", "64:ff9b::a00:1", "não-ip"]) {
    assert.equal(enderecoPublico(ip), false, ip);
  }
  for (const ip of ["104.18.32.47", "2606:4700::6810:20af"]) assert.equal(enderecoPublico(ip), true, ip);
});

test("revisão P2-3: grafias alternativas de IPv6 privado/loopback/mapeado são recusadas (decisão por bytes)", () => {
  const recusar = [
    "::ffff:7f00:1", "::ffff:a00:1", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "::0:1", "::ffff:127.0.0.1",
    "::ffff:0a00:0001", "0:0:0:0:0:ffff:a9fe:a9fe", "::ffff:c0a8:101", "::7f00:1", "::127.0.0.1", "::a00:1", "64:ff9b::7f00:1",
    "64:ff9b:1::a00:1", "2002:7f00:1::", "2001:0:4136:e378::1", "2001:db8::1", "FE80::1", "fec0::1", "fd12:3456::1", "ff05::2",
    "100::1", "::", "fe80::1%eth0", "3fff::1",
  ];
  for (const ip of recusar) assert.equal(enderecoPublico(ip), false, ip);
  // Controle positivo: mapeado para IPv4 PÚBLICO e unicast global comum seguem aceitos.
  for (const ip of ["::ffff:6812:202f", "::ffff:104.18.32.47", "2606:4700:0:0:0:0:6810:20af", "2a00:1450:4001:80b::200e"]) {
    assert.equal(enderecoPublico(ip), true, ip);
  }
});

test("busca fixada: DNS para endereço privado recusa ANTES de conectar (rebinding/SSRF)", async () => {
  const det = instalarDetector();
  try {
    for (const enderecos of [["10.0.0.5"], ["104.18.32.47", "127.0.0.1"], []]) {
      await assert.rejects(buscaHttpsFixada(async () => enderecos)(new URL(ID)), (e: unknown) => e instanceof CimdRecusado && e.motivo === "ENDERECO_NAO_PUBLICO");
    }
    assert.deepEqual(det.destinos, [], "nenhuma conexão tentada");
  } finally {
    det.restaurar();
  }
});

const doc = (over: Record<string, unknown> = {}, extra: Partial<Awaited<ReturnType<BuscaDocumento>>> = {}): BuscaDocumento =>
  async () => ({ status: 200, tipo: "application/json; charset=utf-8", corpo: JSON.stringify({ client_id: ID, client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], token_endpoint_auth_method: "none", ...over }), ...extra });

test("documento CIMD: válido gera cliente com cache; divergências recusam com motivo fechado", async () => {
  const c = await carregarClienteCimd(ID, HOSTS, doc(), AGORA, 3600);
  assert.deepEqual(c.redirectUris, ["https://chatgpt.com/connector_platform_oauth_redirect"]);
  assert.equal(c.validoAte.toISOString(), "2026-10-27T16:00:00.000Z");
  const nome = await carregarClienteCimd(ID, HOSTS, doc({ client_name: "<script>alert(1)</script>" }), AGORA, 60);
  assert.doesNotMatch(nome.nome, /[<>]/);
  const casos: Array<[BuscaDocumento, string]> = [
    [doc({}, { status: 302 }), "STATUS"],
    [doc({}, { tipo: "text/html" }), "TIPO"],
    [doc({}, { corpo: "{" }), "JSON"],
    [doc({ client_id: "https://chatgpt.com/outro.json" }), "DOCUMENTO"],
    [doc({ token_endpoint_auth_method: "private_key_jwt" }), "AUTENTICACAO_CLIENTE_NAO_SUPORTADA"],
    [doc({ token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: ["private_key_jwt", "client_secret_basic"] }), "AUTENTICACAO_CLIENTE_NAO_SUPORTADA"],
    [doc({ token_endpoint_auth_method: "client_secret_basic", token_endpoint_auth_methods_supported: "none" }), "DOCUMENTO"],
    [doc({ grant_types: ["client_credentials"] }), "GRANT"],
    [doc({ redirect_uris: ["http://chatgpt.com/cb", "http://127.0.0.1/callback", "https://chatgpt.com/cb#x"] }), "REDIRECT"],
    [async () => { throw new Error("rede"); }, "FALHA_REDE"],
  ];
  for (const [busca, motivo] of casos) {
    await assert.rejects(carregarClienteCimd(ID, HOSTS, busca, AGORA, 60), (e: unknown) => e instanceof CimdRecusado && e.motivo === motivo, motivo);
  }
  await assert.rejects(carregarClienteCimd("https://evil.example/c.json", HOSTS, doc(), AGORA, 60), (e: unknown) => e instanceof CimdRecusado && e.motivo === "CLIENT_ID_NAO_ACEITO");
});

/** Documento REAL publicado em https://chatgpt.com/oauth/client.json, copiado em 27/10/2026 (público, sem segredo). */
const CHATGPT_REAL_20261027 = {
  client_id: "https://chatgpt.com/oauth/client.json",
  client_uri: "https://chatgpt.com/",
  redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
  token_endpoint_auth_method: "private_key_jwt",
  token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  client_name: "ChatGPT",
  logo_uri: "https://persistent.oaistatic.com/sonic/misc/openai-logo.png",
  token_endpoint_auth_signing_alg: "RS256",
  jwks_uri: "https://chatgpt.com/oauth/jwks.json",
};

test("documento real do ChatGPT (private_key_jwt declarado, none suportado) é aceito; o servidor só anuncia none", async () => {
  const real: BuscaDocumento = async () => ({ status: 200, tipo: "application/json; charset=utf-8", corpo: JSON.stringify(CHATGPT_REAL_20261027) });
  const c = await carregarClienteCimd(ID, HOSTS, real, AGORA, 3600);
  assert.equal(c.clientId, "https://chatgpt.com/oauth/client.json");
  assert.equal(c.nome, "ChatGPT");
  assert.deepEqual(c.redirectUris, ["https://chatgpt.com/connector_platform_oauth_redirect"]);
  // Controle: o mesmo documento sem `none` na lista volta a ser recusado.
  const semNone: BuscaDocumento = async () => ({ status: 200, tipo: "application/json", corpo: JSON.stringify({ ...CHATGPT_REAL_20261027, token_endpoint_auth_methods_supported: ["private_key_jwt"] }) });
  await assert.rejects(carregarClienteCimd(ID, HOSTS, semNone, AGORA, 60), (e: unknown) => e instanceof CimdRecusado && e.motivo === "AUTENTICACAO_CLIENTE_NAO_SUPORTADA");
});

test("limitador: taxa por concessão e por empresa, concorrência e memória limitada", () => {
  let agora = 0;
  const lim = new LimitadorMcp(() => agora, { ...LIMITES_MCP, chamadasPorMinutoPorConcessao: 2, chamadasPorMinutoPorEmpresa: 3, concorrenciaPorConcessao: 1 }, 4);
  const d1 = lim.tentar("c1", "e1");
  assert.ok(d1.ok);
  const conc = lim.tentar("c1", "e1");
  assert.equal(conc.ok, false);
  assert.equal(!conc.ok && conc.motivo, "CONCORRENCIA");
  if (d1.ok) d1.liberar();
  const d2 = lim.tentar("c1", "e1");
  assert.ok(d2.ok);
  if (d2.ok) d2.liberar();
  const taxa = lim.tentar("c1", "e1");
  assert.equal(!taxa.ok && taxa.motivo, "TAXA");
  const outra = lim.tentar("c2", "e1");
  assert.ok(outra.ok);
  if (outra.ok) outra.liberar();
  assert.equal(lim.tentar("c3", "e1").ok, false, "teto da empresa");
  agora = 61_000;
  const nova = lim.tentar("c1", "e1");
  assert.ok(nova.ok, "janela renovada");
  if (nova.ok) nova.liberar();
  for (let i = 0; i < 50; i += 1) {
    agora += 61_000;
    const d = lim.tentar(`x${i}`, `y${i}`);
    if (d.ok) d.liberar();
  }
  assert.ok(lim.tamanho() <= 6, `mapa limitado (${lim.tamanho()})`);
});

// ---------------------------------------------------------------- rodada 4 da revisão (achado 4)

test("rodada 4, achado 4: busca CIMD tem prazo ABSOLUTO (DNS e transferência), destrói o soquete e limita buscas em curso", async () => {
  const { EventEmitter } = await import("node:events");
  const { Vagas } = await import("../mcp/admissao.ts");
  const url = new URL("https://chatgpt.com/oauth/client.json");
  // DNS que nunca responde: recusa no prazo; a vaga só volta quando o DNS terminar de fato.
  let soltarDns: (v: string[]) => void = () => undefined;
  const vagas = new Vagas(1);
  const dnsPreso = buscaHttpsFixada(() => new Promise((ok) => { soltarDns = ok; }), { prazoMs: 80, vagas });
  const inicio = Date.now();
  await assert.rejects(dnsPreso(url), (e: CimdRecusado) => e.motivo === "TEMPO");
  assert.ok(Date.now() - inicio < 1000);
  await assert.rejects(dnsPreso(url), (e: CimdRecusado) => e.motivo === "OCUPADO", "trabalho abandonado ainda ocupa a vaga");
  soltarDns(["127.0.0.1"]);
  await new Promise((ok) => setTimeout(ok, 10));
  assert.equal(vagas.quantas(), 0, "vaga devolvida quando o DNS terminou");

  // Resposta em gotas (nunca inativa por 5 s, mas sem fim): destruída pelo prazo absoluto.
  let destruido = false;
  const abrir = ((_u: unknown, _o: unknown, cb: (res: unknown) => void) => {
    const req = new EventEmitter() as InstanceType<typeof EventEmitter> & { end(): void; destroy(e?: Error): void };
    const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: { "content-type": "application/json" } });
    let gota: ReturnType<typeof setInterval>;
    req.end = () => { cb(res); gota = setInterval(() => res.emit("data", Buffer.from(" ")), 10); };
    req.destroy = (e?: Error) => { destruido = true; clearInterval(gota); req.emit("error", e ?? new Error("x")); req.emit("close"); };
    return req;
  }) as never;
  const gotas = buscaHttpsFixada(async () => ["8.8.8.8"], { prazoMs: 100, vagas: new Vagas(2), abrir });
  await assert.rejects(gotas(url), (e: CimdRecusado) => e.motivo === "TEMPO");
  assert.equal(destruido, true, "soquete destruído no prazo absoluto");
});

test("CIMD-LOOKUP: o endereço fixado passa pelo net real com e sem autoSelectFamily (Node 20+ pede lista)", async () => {
  const { createServer, request } = await import("node:http");
  const corpo = JSON.stringify({ client_id: "https://chatgpt.com/oauth/client.json" });
  const servidor = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(corpo); });
  await new Promise<void>((ok) => servidor.listen(0, "127.0.0.1", ok));
  const porta = (servidor.address() as { port: number }).port;
  try {
    for (const autoSelectFamily of [true, false]) {
      // Repassa o `lookup` do código ao net de verdade, trocando só o IP público fixado por loopback (mesma forma).
      const abrir = ((url: URL, o: { lookup: (h: string, op: unknown, cb: (...a: unknown[]) => void) => void } & Record<string, unknown>, cb: never) =>
        (request as (op: unknown, cb: never) => unknown)({ ...o, host: url.hostname, port: porta, path: url.pathname, autoSelectFamily,
          lookup: (h: string, op: unknown, fim: (...a: unknown[]) => void) => o.lookup(h, op, (erro, end, fam) =>
            fim(erro, Array.isArray(end) ? end.map((e: { family: number }) => ({ ...e, address: "127.0.0.1" })) : typeof end === "string" ? "127.0.0.1" : end, fam)) }, cb)) as never;
      const busca = buscaHttpsFixada(async () => ["8.8.8.8"], { prazoMs: 2000, abrir });
      const r = await busca(new URL("https://chatgpt.com/oauth/client.json"));
      assert.equal(r.status, 200, `autoSelectFamily=${autoSelectFamily}`);
      assert.equal(r.corpo, corpo);
    }
  } finally {
    servidor.close();
  }
});
