import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import type { OtpDelivery } from "../services/models.ts";
import {
  carregarGupshupConfig,
  criarGupshupSender,
  GupshupOtpError,
  normalizarDestinoGupshup,
  type GupshupConfig,
  type GupshupOtpErrorCode,
} from "./gupshup.sender.ts";

const config: GupshupConfig = {
  apiKey: "sk_synthetic_key_for_offline_tests",
  source: "551133334444",
  appName: "KidmaisManager",
  templateId: "8a094387-350e-4f47-90f9-ad47e0548d21",
  defaultCountryCode: "55",
  timeoutMs: 1_000,
};

const delivery: OtpDelivery = {
  validacaoId: "6ac0644b-37e5-4a26-af29-11b86a1647c0",
  canal: "WHATSAPP",
  destino: "(11) 99999-8888",
  codigo: "123456",
  expiraEm: "2026-09-19T21:00:00.000Z",
};

function configurationEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    GUPSHUP_API_KEY: config.apiKey,
    GUPSHUP_SOURCE: config.source,
    GUPSHUP_APP_NAME: config.appName,
    GUPSHUP_OTP_TEMPLATE_ID: config.templateId,
  };
}

function submittedResponse() {
  return new Response(JSON.stringify({ status: "submitted", messageId: "gupshup-message-id" }), {
    status: 202,
  });
}

function safeError(code: GupshupOtpErrorCode) {
  return (error: unknown) => {
    assert.ok(error instanceof GupshupOtpError);
    assert.equal(error.code, code);
    assert.equal("cause" in error, false);
    const serialized = inspect(error);
    for (const sensitive of [config.apiKey, config.source, delivery.destino, "5511999998888", delivery.codigo, "webhook-secret-synthetic", "raw-payload-synthetic"]) {
      assert.equal(serialized.includes(sensitive), false);
    }
    return true;
  };
}

test("carrega variáveis obrigatórias, normaliza source e aplica padrões", () => {
  const env = configurationEnv();
  env.GUPSHUP_SOURCE = "+55 (11) 3333-4444";
  assert.deepEqual(carregarGupshupConfig(env), { ...config, timeoutMs: 10_000 });
  env.GUPSHUP_DEFAULT_COUNTRY_CODE = "1";
  env.GUPSHUP_TIMEOUT_MS = "30000";
  assert.equal(carregarGupshupConfig(env).defaultCountryCode, "1");
  assert.equal(carregarGupshupConfig(env).timeoutMs, 30_000);
});

test("recusa cada variável obrigatória ausente", () => {
  for (const key of ["GUPSHUP_API_KEY", "GUPSHUP_SOURCE", "GUPSHUP_APP_NAME", "GUPSHUP_OTP_TEMPLATE_ID"]) {
    const env = configurationEnv();
    delete env[key];
    assert.throws(() => carregarGupshupConfig(env), safeError("INVALID_CONFIG"));
  }
});

test("valida configuração também na construção direta e não expõe valores inválidos", () => {
  const invalid: Array<Partial<GupshupConfig>> = [
    { apiKey: "invalid-raw-payload-synthetic" },
    { apiKey: "sk_credential\nheader-injection" },
    { source: "0000000000000" },
    { source: "55119999letters8888" },
    { appName: "OutroApp" },
    { templateId: "template\nraw-payload-synthetic" },
    { defaultCountryCode: "0" },
    { defaultCountryCode: "5555" },
    { timeoutMs: 999 },
    { timeoutMs: 30_001 },
    { timeoutMs: Number.NaN },
    { timeoutMs: 1_500.5 },
  ];
  for (const partial of invalid) {
    assert.throws(() => criarGupshupSender({ ...config, ...partial }), safeError("INVALID_CONFIG"));
  }
  for (const value of ["1e3", "0", "30001", "NaN"]) {
    assert.throws(() => carregarGupshupConfig({ ...configurationEnv(), GUPSHUP_TIMEOUT_MS: value }), safeError("INVALID_CONFIG"));
  }
});

test("normaliza nacionais brasileiros e preserva DDI explícito de outros países", () => {
  for (const value of ["(11) 99999-8888", "11999998888", "011 99999-8888", "+55 (11) 99999-8888", "0055 11 99999-8888", "5511999998888"]) {
    assert.equal(normalizarDestinoGupshup(value), "5511999998888");
  }
  assert.equal(normalizarDestinoGupshup("(11) 3333-4444"), "551133334444");
  assert.equal(normalizarDestinoGupshup("+1 (202) 555-0123"), "12025550123");
  assert.equal(normalizarDestinoGupshup("001 202 555-0123"), "12025550123");
  assert.equal(normalizarDestinoGupshup("2025550123", "1"), "12025550123");
});

test("preserva E.164 NANP armazenado sem + quando o DDI configurado é 1", async () => {
  const storedDestination = "12025550123";
  assert.equal(normalizarDestinoGupshup(storedDestination, "1"), storedDestination);
  // Um destino sem prefixo internacional continua sujeito ao DDI padrão.
  assert.throws(() => normalizarDestinoGupshup(storedDestination, "55"), safeError("INVALID_DESTINATION"));
  const sender = criarGupshupSender({ ...config, defaultCountryCode: "1" }, async (_input, init) => {
    assert.ok(init?.body instanceof URLSearchParams);
    assert.equal(init.body.get("destination"), storedDestination);
    return submittedResponse();
  });
  await sender({ ...delivery, destino: storedDestination });
});

test("recusa destinos inválidos antes de qualquer submissão", async () => {
  let calls = 0;
  const sender = criarGupshupSender(config, async () => {
    calls += 1;
    return submittedResponse();
  });
  for (const destino of ["", "123", "123456789", "00000000000", "000000000000000", "5500999998888", "+55 11 9999", "+55119999988888888", "abc11999998888", "55/11/99999-8888", "55+11999998888", "+005511999998888", "(11 99999-8888", "11\n999998888"]) {
    await assert.rejects(sender({ ...delivery, destino }), safeError("INVALID_DESTINATION"));
  }
  assert.equal(calls, 0);
});

test("recusa canal incompatível antes de qualquer submissão", async () => {
  let calls = 0;
  const sender = criarGupshupSender(config, async () => {
    calls += 1;
    return submittedResponse();
  });
  await assert.rejects(sender({ ...delivery, canal: "SMS" }), safeError("INVALID_CHANNEL"));
  assert.equal(calls, 0);
});

test("202 submitted envia formulário exato uma única vez e preserva messageId internamente", async () => {
  let calls = 0;
  const sender = criarGupshupSender(config, async (input, init) => {
    calls += 1;
    assert.equal(input, "https://api.gupshup.io/wa/api/v1/template/msg");
    assert.equal(init?.method, "POST");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("apikey"), config.apiKey);
    assert.equal(headers.get("Content-Type"), "application/x-www-form-urlencoded");
    assert.ok(init?.body instanceof URLSearchParams);
    assert.deepEqual(Object.fromEntries(init.body), {
      channel: "whatsapp",
      source: config.source,
      destination: "5511999998888",
      "src.name": "KidmaisManager",
      template: JSON.stringify({ id: config.templateId, params: [delivery.codigo, delivery.codigo] }),
    });
    assert.equal(init.body.toString().includes(delivery.validacaoId), false);
    assert.equal(init.body.toString().includes(delivery.expiraEm), false);
    return submittedResponse();
  });
  assert.deepEqual(await sender(delivery), { provider: "gupshup", status: "submitted", messageId: "gupshup-message-id" });
  assert.equal(calls, 1);
});

test("aceita JSON válido mesmo quando provedor declara text/html", async () => {
  const sender = criarGupshupSender(config, async () => new Response(JSON.stringify({ status: "submitted", messageId: "message-id" }), {
    status: 202,
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  }));
  assert.equal((await sender(delivery)).messageId, "message-id");
});

for (const [status, code] of [
  [401, "AUTHENTICATION"], [403, "AUTHENTICATION"], [429, "UNAVAILABLE"],
  [500, "UNAVAILABLE"], [503, "UNAVAILABLE"], [400, "REJECTED"], [302, "REJECTED"],
  [200, "INVALID_RESPONSE"],
] as const) {
  test(`classifica HTTP ${status} como ${code} sem retry nem exposição do corpo`, async () => {
    let calls = 0;
    const sender = criarGupshupSender(config, async () => {
      calls += 1;
      return new Response(`raw-payload-synthetic ${delivery.codigo} ${config.apiKey} ${delivery.destino}`, { status });
    });
    await assert.rejects(sender(delivery), safeError(code));
    assert.equal(calls, 1);
  });
}

test("mapeia erro de rede sem preservar mensagem maliciosa ou cause", async () => {
  let calls = 0;
  const sender = criarGupshupSender(config, async () => {
    calls += 1;
    throw new Error(`raw-payload-synthetic ${delivery.codigo} ${config.apiKey} ${delivery.destino} webhook-secret-synthetic`, {
      cause: { body: delivery },
    });
  });
  await assert.rejects(sender(delivery), safeError("UNAVAILABLE"));
  assert.equal(calls, 1);
});

test("timeout cobre fetch que não responde, aborta e não faz retry", async () => {
  let calls = 0;
  let signal: AbortSignal | null | undefined;
  const sender = criarGupshupSender(config, async (_input, init) => {
    calls += 1;
    signal = init?.signal;
    return new Promise<Response>(() => undefined);
  });
  await assert.rejects(sender(delivery), safeError("TIMEOUT"));
  assert.equal(signal?.aborted, true);
  assert.equal(calls, 1);
});

test("timeout continua durante leitura do corpo e cancela o stream", async () => {
  let calls = 0;
  let cancelled = false;
  const sender = criarGupshupSender(config, async () => {
    calls += 1;
    return new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    }), { status: 202 });
  });
  await assert.rejects(sender(delivery), safeError("TIMEOUT"));
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
});

test("202 com JSON inválido, status incorreto ou messageId ausente é resposta inválida", async () => {
  for (const body of ["not-json", "null", "[]", "{}", '{"status":"enqueued","messageId":"id"}', '{"status":"submitted"}', '{"status":"submitted","messageId":""}', '{"status":"submitted","messageId":123}', JSON.stringify({ status: "submitted", messageId: "a".repeat(257) }), JSON.stringify({ status: "submitted", messageId: "id\nraw-payload-synthetic" })]) {
    let calls = 0;
    const sender = criarGupshupSender(config, async () => {
      calls += 1;
      return new Response(body, { status: 202 });
    });
    await assert.rejects(sender(delivery), safeError("INVALID_RESPONSE"));
    assert.equal(calls, 1);
  }
});

test("limita corpo da resposta a 16 KiB e cancela resposta excessiva", async () => {
  let cancelled = false;
  const sender = criarGupshupSender(config, async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(16_385)); },
    cancel() { cancelled = true; },
  }), { status: 202 }));
  await assert.rejects(sender(delivery), safeError("INVALID_RESPONSE"));
  assert.equal(cancelled, true);
});

test("falha de leitura do corpo não expõe mensagem do stream", async () => {
  const sender = criarGupshupSender(config, async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error(`raw-payload-synthetic ${config.apiKey} ${delivery.codigo}`)); },
  }), { status: 202 }));
  await assert.rejects(sender(delivery), safeError("INVALID_RESPONSE"));
});

test("UTF-8 inválido encerra o stream sem aguardar o restante do corpo", async () => {
  let cancelled = false;
  const sender = criarGupshupSender(config, async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([0xff])); },
    cancel() { cancelled = true; },
  }), { status: 202 }));
  await assert.rejects(sender(delivery), safeError("INVALID_RESPONSE"));
  assert.equal(cancelled, true);
});

test("sucesso e falhas nunca registram OTP, telefone, chave, secret ou payload", async (context) => {
  const methods = ["debug", "info", "warn", "error", "log", "trace"] as const;
  const spies = methods.map((method) => context.mock.method(console, method, () => undefined));
  const sensitive = `raw-payload-synthetic ${config.apiKey} ${config.source} ${delivery.codigo} ${delivery.destino} webhook-secret-synthetic`;
  await criarGupshupSender(config, async () => submittedResponse())(delivery);
  await assert.rejects(criarGupshupSender(config, async () => new Response(sensitive, { status: 401 }))(delivery), safeError("AUTHENTICATION"));
  await assert.rejects(criarGupshupSender(config, async () => { throw new Error(sensitive); })(delivery), safeError("UNAVAILABLE"));
  await assert.rejects(criarGupshupSender(config, async () => new Response(sensitive, { status: 202 }))(delivery), safeError("INVALID_RESPONSE"));
  assert.equal(spies.reduce((total, spy) => total + spy.mock.callCount(), 0), 0);
});
