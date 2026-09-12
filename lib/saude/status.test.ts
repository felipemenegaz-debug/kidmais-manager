import assert from "node:assert/strict";
import test from "node:test";

import {
  avaliarProntidao,
  linhasDiagnosticoStaging,
  respostaSaudeDisponivel,
} from "./status.ts";

test("health de staging fica degradado sem derrubar banco e Festa", () => {
  assert.deepEqual(
    respostaSaudeDisponivel({ provider: "disabled", status: "unavailable" }),
    {
      ok: true,
      status: "degraded",
      components: { database: "ready", festa: "ready", otp: "unavailable" },
    },
  );
});

test("health permanece pronto quando WhatsApp está configurado", () => {
  assert.deepEqual(
    respostaSaudeDisponivel({ provider: "whatsapp_cloud", status: "ready" }),
    {
      ok: true,
      status: "ready",
      components: { database: "ready", festa: "ready", otp: "ready" },
    },
  );
});

test("OTP disabled autorizado mantém prontidão em estado degradado", async () => {
  const resultado = await avaliarProntidao({
    verificarDatabase: async () => true,
    validarFesta: async () => undefined,
    validarOtp: () => ({ provider: "disabled", status: "unavailable" }),
    festaHabilitada: true,
  });

  assert.equal(resultado.disponivel, true);
  assert.deepEqual(resultado.componentes, {
    database: { status: "ready" },
    festa: { status: "ready" },
    otp: {
      status: "unavailable",
      codigo: "OTP_STAGING_DISABLED_EXPECTED",
    },
  });
});

test("falha de banco produz diagnóstico sanitizado e não consulta Festa", async () => {
  let festaConsultada = false;
  const resultado = await avaliarProntidao({
    verificarDatabase: async () => {
      throw new Error("postgresql://usuario:senha@host/banco");
    },
    validarFesta: async () => {
      festaConsultada = true;
    },
    validarOtp: () => ({ provider: "disabled", status: "unavailable" }),
    festaHabilitada: true,
  });

  assert.equal(resultado.disponivel, false);
  assert.equal(festaConsultada, false);
  const linhas = linhasDiagnosticoStaging(resultado, {
    KIDMAIS_DEPLOY_ENV: "staging",
  });
  assert.deepEqual(linhas, [
    "[Kidmais Health] database=failed code=DATABASE_CONNECTION_FAILED",
    "[Kidmais Health] festa=failed code=FESTA_DATABASE_UNAVAILABLE",
    "[Kidmais Health] otp=unavailable code=OTP_STAGING_DISABLED_EXPECTED",
  ]);
  assert.equal(linhas.join(" ").includes("usuario:senha"), false);
});

test("assinatura inválida de Festa recusa prontidão com código seguro", async () => {
  const resultado = await avaliarProntidao({
    verificarDatabase: async () => true,
    validarFesta: async () => {
      throw new Error("assinatura observada e detalhes internos");
    },
    validarOtp: () => ({ provider: "whatsapp_cloud", status: "ready" }),
    festaHabilitada: true,
  });

  assert.equal(resultado.disponivel, false);
  assert.deepEqual(
    linhasDiagnosticoStaging(resultado, { KIDMAIS_DEPLOY_ENV: "staging" }),
    [
      "[Kidmais Health] database=ready",
      "[Kidmais Health] festa=failed code=FESTA_INSTALLATION_NOT_VALIDATED",
      "[Kidmais Health] otp=ready",
    ],
  );
});

test("Festa desabilitada é distinguida de assinatura inválida", async () => {
  const resultado = await avaliarProntidao({
    verificarDatabase: async () => true,
    validarFesta: async () => undefined,
    validarOtp: () => ({ provider: "whatsapp_cloud", status: "ready" }),
    festaHabilitada: false,
  });

  assert.equal(resultado.disponivel, false);
  assert.deepEqual(resultado.componentes.festa, {
    status: "failed",
    codigo: "FESTA_DISABLED",
  });
});

test("configuração OTP inválida recusa prontidão sem expor a exceção", async () => {
  const resultado = await avaliarProntidao({
    verificarDatabase: async () => true,
    validarFesta: async () => undefined,
    validarOtp: () => {
      throw new Error("token-super-secreto");
    },
    festaHabilitada: true,
  });

  assert.equal(resultado.disponivel, false);
  const linhas = linhasDiagnosticoStaging(resultado, {
    KIDMAIS_DEPLOY_ENV: "staging",
  });
  assert.equal(
    linhas.at(-1),
    "[Kidmais Health] otp=failed code=OTP_CONFIG_INVALID",
  );
  assert.equal(linhas.join(" ").includes("token-super-secreto"), false);
  assert.deepEqual(linhasDiagnosticoStaging(resultado, {}), []);
});
