import net from "node:net";

/**
 * SOMENTE TESTE. Detector de saída de rede para a prova de zero inferência (A2): intercepta `fetch` global e
 * `net.Socket.prototype.connect` (base de http/https/undici). Loopback é permitido; qualquer outro destino é REGISTRADO e
 * BLOQUEADO (nunca sai de verdade). O controle positivo injeta uma chamada proibida e exige que ela apareça aqui.
 */
export type Detector = { destinos: string[]; restaurar(): void };

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/i;

/**
 * Destino de `socket.connect(...)` em todas as formas (revisão P2-5): `net.connect`/`https`/`tls` chamam com os
 * argumentos NORMALIZADOS num array `[opções, callback]`; chamadas diretas usam `(opções)`, `(porta, host)` ou
 * `(caminho)`. Forma desconhecida não é presumida loopback: vira "desconhecido" e é bloqueada.
 */
export function destinoDoConnect(args: readonly unknown[]): string {
  const primeiro = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof primeiro === "object" && primeiro !== null) {
    const o = primeiro as { host?: unknown; path?: unknown };
    if (typeof o.path === "string") return "ipc";
    return typeof o.host === "string" && o.host !== "" ? o.host : "localhost"; // padrão do Node sem host: localhost
  }
  if (typeof primeiro === "number" || (typeof primeiro === "string" && /^\d+$/.test(primeiro))) return typeof args[1] === "string" ? args[1] : "localhost";
  if (typeof primeiro === "string") return "ipc";
  return "desconhecido";
}

export function instalarDetector(): Detector {
  const destinos: string[] = [];
  const fetchOriginal = globalThis.fetch;
  const connectOriginal = net.Socket.prototype.connect;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!LOOPBACK.test(url.hostname)) {
      destinos.push(`fetch:${url.hostname}`);
      throw new Error("Rede externa bloqueada no teste.");
    }
    return fetchOriginal(input, init);
  }) as typeof fetch;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const host = destinoDoConnect(args);
    if (host !== "ipc" && !LOOPBACK.test(host)) {
      destinos.push(`socket:${host}`);
      // Nada conecta. O erro sai no próximo tick, só se alguém ouve (tls.connect lança antes de ouvir: destruição silenciosa).
      process.nextTick(() => (this.listenerCount("error") > 0 ? this.destroy(new Error("Rede externa bloqueada no teste.")) : this.destroy()));
      return this;
    }
    return (connectOriginal as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  return {
    destinos,
    restaurar() {
      globalThis.fetch = fetchOriginal;
      net.Socket.prototype.connect = connectOriginal;
    },
  };
}
