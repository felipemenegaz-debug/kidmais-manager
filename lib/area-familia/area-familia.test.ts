import assert from "node:assert/strict";
import test from "node:test";
import { areaFamiliaLigada, lerCorpoJson, origemPublicaValida, pepperIdentidade } from "./regras-http.ts";
import {
  caminhoArea, cookieApagado, cookieDaSessao, documentoCanonico, FORMATO_TOKEN_AREA, gerarTokenArea, hashCodigoArea,
  hashDocumentoPessoa, hashesIguais, hashTokenArea, nomeCookieArea, rotuloAparelho,
} from "./tokens.ts";

// Área "Minha festa" (123, F1): partes sem banco. As regras com banco estão em area-familia.postgres.test.ts.

test("token do link: 32 bytes base64url, nunca repete; só o SHA-256 vai ao banco", () => {
  const a = gerarTokenArea();
  const b = gerarTokenArea();
  assert.match(a, FORMATO_TOKEN_AREA);
  assert.notEqual(a, b);
  assert.match(hashTokenArea(a), /^[a-f0-9]{64}$/);
  assert.notEqual(hashTokenArea(a), hashTokenArea(b));
  assert.equal(hashTokenArea(a), hashTokenArea(a));
});

test("documento do segundo: HMAC com pepper, ignora máscara; pepper diferente muda o hash", () => {
  const p1 = "pepper-de-teste-1234567890";
  const p2 = "pepper-de-teste-0987654321";
  assert.equal(hashDocumentoPessoa("529.982.247-25", p1), hashDocumentoPessoa("52998224725", p1));
  assert.notEqual(hashDocumentoPessoa("52998224725", p1), hashDocumentoPessoa("52998224725", p2));
  assert.notEqual(hashDocumentoPessoa("52998224725", p1), hashTokenArea("52998224725"));
});

test("CNPJ alfanumérico (AF-R2): letras entram no HMAC; sem letras ou com letras trocadas não confere", () => {
  const p = "pepper-de-teste-1234567890";
  const certo = hashDocumentoPessoa("12ABC34501DE35", p);
  assert.equal(documentoCanonico("12.abc.345/01de-35"), "12ABC34501DE35");
  assert.equal(hashDocumentoPessoa("12.ABC.345/01DE-35", p), certo);
  assert.equal(hashDocumentoPessoa("12.abc.345/01de-35", p), certo);
  assert.notEqual(hashDocumentoPessoa("123450135", p), certo);
  assert.notEqual(hashDocumentoPessoa("12ACB34501DE35", p), certo);
  assert.notEqual(hashDocumentoPessoa("12ABC34501ED35", p), certo);
  // CPF continua só com dígitos: mesma forma de antes.
  assert.equal(documentoCanonico("529.982.247-25"), "52998224725");
});

test("código da área (AF-R1): amarrado ao WhatsApp de destino, à validade e ao cliente", () => {
  const p = "pepper-de-teste-1234567890";
  const base = { clienteId: "c-1", destino: "(11) 98888-7777", codigoExpiraEm: "2026-11-14T10:00:00.000Z" };
  const h = hashCodigoArea("123456", p, base);
  assert.match(h, /^[a-f0-9]{64}$/);
  assert.equal(hashCodigoArea("123456", p, { ...base, destino: "11988887777" }), h);
  assert.equal(hashCodigoArea("123456", p, { ...base, codigoExpiraEm: "2026-11-14T07:00:00-03:00" }), h);
  assert.notEqual(hashCodigoArea("123456", p, { ...base, destino: "11977776666" }), h);
  assert.notEqual(hashCodigoArea("123456", p, { ...base, clienteId: "c-2" }), h);
  assert.notEqual(hashCodigoArea("123457", p, base), h);
  assert.notEqual(hashCodigoArea("123456", p, { ...base, codigoExpiraEm: "2026-11-14T10:00:01.000Z" }), h);
});

test("comparação de hashes: só hex de 64; diferente ou malformado → false", () => {
  const h = hashTokenArea("x");
  assert.equal(hashesIguais(h, h), true);
  assert.equal(hashesIguais(h, h.toUpperCase()), true);
  assert.equal(hashesIguais(h, hashTokenArea("y")), false);
  assert.equal(hashesIguais(h, ""), false);
  assert.equal(hashesIguais("z".repeat(64), "z".repeat(64)), false);
});

test("cookie: __Secure, HttpOnly, Lax, caminho da área da empresa; 12 h sem lembrar (cookie de sessão), 30 dias com", () => {
  assert.equal(nomeCookieArea("buffet-alegria"), "__Secure-kmaf-buffet-alegria");
  assert.equal(caminhoArea("buffet-alegria"), "/b/buffet-alegria/minha-festa");
  for (const ruim of ["", "A", "a", "buffet/../x", "Buffet", "-buffet", "buffet-", "b;x"]) {
    assert.throws(() => nomeCookieArea(ruim), /CODIGO_EMPRESA_INVALIDO/, ruim);
    assert.throws(() => caminhoArea(ruim), /CODIGO_EMPRESA_INVALIDO/, ruim);
  }
  const fim = new Date(Date.now() + 1000);
  const curto = cookieDaSessao("buffet-alegria", "t", false, fim);
  assert.deepEqual(curto, { name: "__Secure-kmaf-buffet-alegria", value: "t", httpOnly: true, secure: true, sameSite: "lax", path: "/b/buffet-alegria/minha-festa" });
  assert.equal(cookieDaSessao("buffet-alegria", "t", true, fim).expires, fim);
  const apagado = cookieApagado("buffet-alegria");
  assert.equal(apagado.value, "");
  assert.equal(apagado.expires?.getTime(), 0);
  assert.equal(apagado.path, "/b/buffet-alegria/minha-festa");
});

test("rótulo do aparelho: curto, sem o user-agent inteiro", () => {
  assert.equal(rotuloAparelho("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17.0 Mobile Safari/604.1"), "Safari no iPhone/iPad");
  assert.equal(rotuloAparelho("Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile Safari/537.36"), "Chrome no Android");
  assert.equal(rotuloAparelho("Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36 Edg/120.0"), "Edge no Windows");
  assert.equal(rotuloAparelho(null), null);
  assert.equal(rotuloAparelho("curl/8.0"), null);
});

test("trava AREA_FAMILIA_ENABLED: só 'true' liga", () => {
  assert.equal(areaFamiliaLigada({}), false);
  assert.equal(areaFamiliaLigada({ AREA_FAMILIA_ENABLED: "1" }), false);
  assert.equal(areaFamiliaLigada({ AREA_FAMILIA_ENABLED: "TRUE" }), false);
  assert.equal(areaFamiliaLigada({ AREA_FAMILIA_ENABLED: "true" }), true);
});

test("pepper da identidade: ausente ou curto → null", () => {
  assert.equal(pepperIdentidade({}), null);
  assert.equal(pepperIdentidade({ IDENTIDADE_OTP_PEPPER: "curto" }), null);
  assert.equal(pepperIdentidade({ IDENTIDADE_OTP_PEPPER: "                    " }), null);
  assert.equal(pepperIdentidade({ IDENTIDADE_OTP_PEPPER: "p".repeat(16) }), "p".repeat(16));
});

function pedido(headers: Record<string, string>, corpo?: string) {
  return new Request("https://app.exemplo.test/b/buffet/minha-festa/api/iniciar", { method: "POST", headers, body: corpo });
}

test("origem: exige Origin igual à configurada; Sec-Fetch-Site de outro site recusa; sem configuração recusa", () => {
  const env = { AREA_FAMILIA_PUBLIC_ORIGIN: "https://app.exemplo.test/qualquer" };
  assert.equal(origemPublicaValida(pedido({ origin: "https://app.exemplo.test" }), env), true);
  assert.equal(origemPublicaValida(pedido({ origin: "https://app.exemplo.test", "sec-fetch-site": "same-origin" }), env), true);
  assert.equal(origemPublicaValida(pedido({ origin: "https://app.exemplo.test", "sec-fetch-site": "cross-site" }), env), false);
  assert.equal(origemPublicaValida(pedido({ origin: "https://app.exemplo.test", "sec-fetch-site": "same-site" }), env), false);
  assert.equal(origemPublicaValida(pedido({ origin: "https://outro.test" }), env), false);
  assert.equal(origemPublicaValida(pedido({}), env), false);
  assert.equal(origemPublicaValida(pedido({ origin: "https://app.exemplo.test" }), {}), false);
  assert.equal(origemPublicaValida(pedido({ origin: "https://app.exemplo.test" }), { ADMIN_AUTH_ORIGIN: "https://app.exemplo.test" }), true);
  assert.equal(origemPublicaValida(pedido({ origin: "null" }), { AREA_FAMILIA_PUBLIC_ORIGIN: "lixo" }), false);
});

test("corpo: só JSON até 4 KB; outro tipo, grande demais ou inválido → null", async () => {
  assert.deepEqual(await lerCorpoJson(pedido({ "content-type": "application/json" }, '{"a":1}')), { a: 1 });
  assert.deepEqual(await lerCorpoJson(pedido({ "content-type": "application/json; charset=utf-8" }, "[]")), []);
  assert.equal(await lerCorpoJson(pedido({ "content-type": "text/plain" }, '{"a":1}')), null);
  assert.equal(await lerCorpoJson(pedido({ "content-type": "application/x-www-form-urlencoded" }, "a=1")), null);
  assert.equal(await lerCorpoJson(pedido({ "content-type": "application/json" }, "{")), null);
  assert.equal(await lerCorpoJson(pedido({ "content-type": "application/json" }, JSON.stringify({ x: "a".repeat(5000) }))), null);
});
