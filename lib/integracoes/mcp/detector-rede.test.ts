import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { destinoDoConnect, instalarDetector } from "./detector-rede-teste.ts";

/**
 * Revisão P2-5: controles POSITIVOS do detector da prova de zero inferência. Cada caminho de saída comum do Node precisa
 * ser registrado e bloqueado (nada sai de verdade: o soquete é destruído antes da resolução de nome).
 */
const falha = (emissor: { once(ev: "error", cb: (e: Error) => void): unknown }) => new Promise<Error>((ok) => { emissor.once("error", ok); });

test("destinoDoConnect entende argumentos normalizados, diretos, porta+host, caminho e forma desconhecida", () => {
  assert.equal(destinoDoConnect([[{ host: "api.openai.com", port: 443 }, () => undefined]]), "api.openai.com");
  assert.equal(destinoDoConnect([{ host: "api.anthropic.com", port: 443 }]), "api.anthropic.com");
  assert.equal(destinoDoConnect([443, "generativelanguage.googleapis.com"]), "generativelanguage.googleapis.com");
  assert.equal(destinoDoConnect([[{ port: 80 }, null]]), "localhost");
  assert.equal(destinoDoConnect([{ path: "/tmp/s.sock" }]), "ipc");
  assert.equal(destinoDoConnect([Symbol("x")]), "desconhecido");
});

test("controles positivos: net.connect, http, https e tls para fora são registrados e bloqueados; loopback passa", async () => {
  const det = instalarDetector();
  try {
    await falha(net.connect({ host: "api.openai.com", port: 443 }));
    await falha(net.connect(443, "api.anthropic.com"));
    const r1 = https.request("https://api.openai.com/v1/responses", { method: "POST" });
    const e1 = falha(r1);
    r1.end();
    await e1;
    const r2 = http.get("http://example.com/");
    await falha(r2);
    // TLS: com o connect barrado o próprio tls.connect lança de forma síncrona — também é bloqueio, desde que registrado.
    try {
      await falha(tls.connect({ host: "generativelanguage.googleapis.com", port: 443, servername: "generativelanguage.googleapis.com" }));
    } catch {
      /* bloqueio síncrono */
    }
    await assert.rejects(fetch("https://api.deepseek.com/v1/chat"), /bloqueada/);
    assert.deepEqual(det.destinos.sort(), [
      "fetch:api.deepseek.com", "socket:api.anthropic.com", "socket:api.openai.com", "socket:api.openai.com", "socket:example.com", "socket:generativelanguage.googleapis.com",
    ]);
    // Loopback continua permitido (o próprio servidor de teste).
    const srv = net.createServer((s) => s.end()).listen(0, "127.0.0.1");
    await new Promise((ok) => srv.once("listening", ok));
    const porta = (srv.address() as net.AddressInfo).port;
    const s = net.connect(porta, "127.0.0.1");
    await new Promise((ok) => s.once("connect", ok));
    s.destroy();
    srv.close();
    assert.equal(det.destinos.length, 6, "loopback não registrado");
  } finally {
    det.restaurar();
  }
});
