import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { OtpDelivery } from "../services/models.ts";
import {
  criarWhatsappCloudSender,
  enviarOtpComAmbiente,
  normalizarDestinoWhatsapp,
  validarConfiguracaoOtpAmbiente,
  type WhatsappCloudConfig,
} from "./otp.sender.ts";

const config: WhatsappCloudConfig = {
  graphApiVersion: "v99.0",
  phoneNumberId: "123456789012345",
  accessToken: "test-access-token-with-at-least-20-characters",
  templateName: "kidmais_codigo_aceite",
  templateLanguage: "pt_BR",
  defaultCountryCode: "55",
  timeoutMs: 2_000,
};

const delivery: OtpDelivery = {
  validacaoId: "0a6fa249-a8be-4709-af09-6329f6379db6",
  canal: "WHATSAPP",
  destino: "(11) 99999-8888",
  codigo: "123456",
  expiraEm: "2026-09-11T21:00:00.000Z",
};

test("normaliza telefone brasileiro para o formato internacional do WhatsApp", () => {
  assert.equal(normalizarDestinoWhatsapp("(11) 99999-8888"), "5511999998888");
  assert.equal(normalizarDestinoWhatsapp("+55 11 99999-8888"), "5511999998888");
  assert.equal(normalizarDestinoWhatsapp("0055 11 99999-8888"), "5511999998888");
  assert.equal(normalizarDestinoWhatsapp("011 99999-8888"), "5511999998888");
  assert.throws(() => normalizarDestinoWhatsapp("123"), /inválido/);
});

test("envia template OTP pela API oficial sem expor metadados internos", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetchMock: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ messages: [{ id: "wamid.test" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await criarWhatsappCloudSender(config, fetchMock)(delivery);

  assert.equal(
    requestUrl,
    "https://graph.facebook.com/v99.0/123456789012345/messages",
  );
  assert.equal(requestInit?.method, "POST");
  assert.equal(
    new Headers(requestInit?.headers).get("Authorization"),
    `Bearer ${config.accessToken}`,
  );

  const body = JSON.parse(String(requestInit?.body));
  assert.deepEqual(body, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "5511999998888",
    type: "template",
    template: {
      name: "kidmais_codigo_aceite",
      language: { code: "pt_BR" },
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: "123456" }],
        },
      ],
    },
  });
  assert.equal(JSON.stringify(body).includes(delivery.validacaoId), false);
});

test("recusa SMS antes de chamar o provedor externo", async () => {
  let chamadas = 0;
  const fetchMock: typeof fetch = async () => {
    chamadas += 1;
    return new Response();
  };

  await assert.rejects(
    criarWhatsappCloudSender(config, fetchMock)({
      ...delivery,
      canal: "SMS",
    }),
    /somente por WhatsApp/,
  );
  assert.equal(chamadas, 0);
});

test("erro do provedor não replica corpo, token ou telefone", async () => {
  const fetchMock: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          code: 131000,
          message: `do-not-expose ${config.accessToken} ${delivery.destino}`,
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );

  await assert.rejects(
    criarWhatsappCloudSender(config, fetchMock)(delivery),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 400, código 131000/);
      assert.equal(error.message.includes("do-not-expose"), false);
      assert.equal(error.message.includes(config.accessToken), false);
      assert.equal(error.message.includes(delivery.destino), false);
      return true;
    },
  );
});

test("rotas públicas da V1 aceitam somente WHATSAPP", () => {
  const identidadeRoute = readFileSync(
    new URL("../../../app/api/identidade/iniciar-desafio/route.ts", import.meta.url),
    "utf8",
  );
  const contratoRoute = readFileSync(
    new URL(
      "../../../app/api/contratos/[contratoId]/identidade/iniciar/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const identityService = readFileSync(
    new URL("../services/identity.service.ts", import.meta.url),
    "utf8",
  );

  assert.match(identidadeRoute, /canal: z\.literal\("WHATSAPP"\)/);
  assert.match(contratoRoute, /canal: z\.literal\("WHATSAPP"\)/);
  assert.doesNotMatch(identityService, /canal: "SMS",/);
  assert.doesNotMatch(identityService, /canal: "EMAIL",/);
});

test("configuração fora do staging falha fechada e aceita somente whatsapp_cloud", () => {
  const env = process.env as Record<string, string | undefined>;
  const keys = [
    "NODE_ENV",
    "KIDMAIS_DEPLOY_ENV",
    "KIDMAIS_STAGING_OTP_DISABLED",
    "IDENTIDADE_OTP_PROVIDER",
    "WHATSAPP_CLOUD_API_VERSION",
    "WHATSAPP_CLOUD_PHONE_NUMBER_ID",
    "WHATSAPP_CLOUD_ACCESS_TOKEN",
    "WHATSAPP_OTP_TEMPLATE_NAME",
    "WHATSAPP_OTP_TEMPLATE_LANGUAGE",
  ] as const;
  const anteriores = Object.fromEntries(keys.map((key) => [key, env[key]]));

  try {
    env.NODE_ENV = "production";
    env.IDENTIDADE_OTP_PROVIDER = "console";
    assert.throws(validarConfiguracaoOtpAmbiente, /não é permitido/);

    env.IDENTIDADE_OTP_PROVIDER = "disabled";
    env.KIDMAIS_DEPLOY_ENV = "production";
    env.KIDMAIS_STAGING_OTP_DISABLED = "SIM";
    assert.throws(validarConfiguracaoOtpAmbiente, /somente no staging/);

    env.KIDMAIS_DEPLOY_ENV = "staging";
    delete env.KIDMAIS_STAGING_OTP_DISABLED;
    assert.throws(validarConfiguracaoOtpAmbiente, /somente no staging/);

    env.KIDMAIS_STAGING_OTP_DISABLED = "SIM";
    assert.deepEqual(validarConfiguracaoOtpAmbiente(), {
      provider: "disabled",
      status: "unavailable",
    });

    env.IDENTIDADE_OTP_PROVIDER = "whatsapp_cloud";
    env.WHATSAPP_CLOUD_API_VERSION = config.graphApiVersion;
    env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = config.phoneNumberId;
    env.WHATSAPP_CLOUD_ACCESS_TOKEN = config.accessToken;
    env.WHATSAPP_OTP_TEMPLATE_NAME = config.templateName;
    env.WHATSAPP_OTP_TEMPLATE_LANGUAGE = config.templateLanguage;
    assert.doesNotThrow(validarConfiguracaoOtpAmbiente);

    delete env.WHATSAPP_CLOUD_ACCESS_TOKEN;
    assert.throws(validarConfiguracaoOtpAmbiente, /ACCESS_TOKEN não configurada/);
  } finally {
    for (const key of keys) {
      const value = anteriores[key];
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
});

const gupshupEnv: Record<string, string | undefined> = {
  NODE_ENV: "production",
  KIDMAIS_DEPLOY_ENV: "staging",
  IDENTIDADE_OTP_PROVIDER: "gupshup",
  KIDMAIS_STAGING_OTP_DISABLED: undefined,
  GUPSHUP_OTP_ENABLED: undefined,
  GUPSHUP_API_KEY: "sk_synthetic_test_key_abcdefghijklmnopqrstuvwxyz",
  GUPSHUP_SOURCE: "551140028922",
  GUPSHUP_APP_NAME: "KidmaisManager",
  GUPSHUP_OTP_TEMPLATE_ID: "f250d578-370b-423c-b60d-6814cd72d00e",
  GUPSHUP_DEFAULT_COUNTRY_CODE: "55",
  GUPSHUP_TIMEOUT_MS: "1000",
};

async function comAmbiente(env: Record<string, string | undefined>, work: () => Promise<void>) {
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await work();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Gupshup configurado mas bloqueado valida configuração sem rede ou logs", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Rede proibida"); });
  const logs = ["info", "warn", "error", "log", "debug"].map(method =>
    t.mock.method(console, method as "info", () => {}));
  await comAmbiente(gupshupEnv, async () => {
    assert.deepEqual(validarConfiguracaoOtpAmbiente(), {
      provider: "gupshup", status: "unavailable", configured: true, enabled: false,
      reason: "staging_disabled",
    });
    await assert.rejects(enviarOtpComAmbiente(delivery), /temporariamente indisponível/);
    delete process.env.GUPSHUP_API_KEY;
    assert.throws(validarConfiguracaoOtpAmbiente, /GUPSHUP_API_KEY/);
    await assert.rejects(enviarOtpComAmbiente(delivery), /GUPSHUP_API_KEY/);
  });
  assert.equal(fetchMock.mock.callCount(), 0);
  for (const log of logs) assert.equal(log.mock.callCount(), 0);
});

test("seleção por ambiente retorna recibo interno apenas com liberação explícita", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    status: "submitted", messageId: "f27081b2-329f-4e8e-b933-8f3bad50ab76",
  }), { status: 202 }));
  await comAmbiente({ ...gupshupEnv, GUPSHUP_OTP_ENABLED: "true" }, async () => {
    assert.deepEqual(validarConfiguracaoOtpAmbiente(), {
      provider: "gupshup", status: "ready", configured: true, enabled: true,
    });
    assert.deepEqual(await enviarOtpComAmbiente(delivery), {
      provider: "gupshup", status: "submitted", messageId: "f27081b2-329f-4e8e-b933-8f3bad50ab76",
    });
    process.env.KIDMAIS_STAGING_OTP_DISABLED = "SIM";
    await assert.rejects(enviarOtpComAmbiente(delivery), /temporariamente indisponível/);
  });
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("simulação console de desenvolvimento nunca registra OTP ou destino", async (t) => {
  const logs = ["info", "warn", "error", "log", "debug"].map(method =>
    t.mock.method(console, method as "info", () => {}));
  await comAmbiente({ NODE_ENV: "development", IDENTIDADE_OTP_PROVIDER: "console" }, async () => {
    assert.equal(await enviarOtpComAmbiente(delivery), undefined);
  });
  for (const log of logs) assert.equal(log.mock.callCount(), 0);
});

test("emissor desabilitado no staging recusa sem registrar o código", async () => {
  const env = process.env as Record<string, string | undefined>;
  const keys = [
    "NODE_ENV",
    "KIDMAIS_DEPLOY_ENV",
    "KIDMAIS_STAGING_OTP_DISABLED",
    "IDENTIDADE_OTP_PROVIDER",
  ] as const;
  const anteriores = Object.fromEntries(keys.map((key) => [key, env[key]]));
  const consoleInfoOriginal = console.info;
  let logs = 0;

  try {
    env.NODE_ENV = "production";
    env.KIDMAIS_DEPLOY_ENV = "staging";
    env.KIDMAIS_STAGING_OTP_DISABLED = "SIM";
    env.IDENTIDADE_OTP_PROVIDER = "disabled";
    console.info = () => { logs += 1; };

    await assert.rejects(
      enviarOtpComAmbiente(delivery),
      /temporariamente indisponível/,
    );
    assert.equal(logs, 0);
  } finally {
    console.info = consoleInfoOriginal;
    for (const key of keys) {
      const value = anteriores[key];
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
});
