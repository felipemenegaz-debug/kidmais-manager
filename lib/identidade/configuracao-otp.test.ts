import assert from "node:assert/strict";
import test from "node:test";
import { modoOtpAmbiente, otpDesabilitadoNoStaging } from "./configuracao-otp.ts";

const staging: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  KIDMAIS_DEPLOY_ENV: "staging",
  IDENTIDADE_OTP_PROVIDER: "gupshup",
};

test("Gupshup exige ambiente explícito e staging fica bloqueado por padrão", () => {
  assert.equal(modoOtpAmbiente(staging), "gupshup");
  assert.equal(otpDesabilitadoNoStaging(staging), true);
  assert.equal(otpDesabilitadoNoStaging({ ...staging, GUPSHUP_OTP_ENABLED: "false" }), true);
  for (const KIDMAIS_DEPLOY_ENV of [undefined, "local"]) {
    assert.throws(() => modoOtpAmbiente({ ...staging, KIDMAIS_DEPLOY_ENV }), /ambiente staging ou production/);
    assert.throws(() => otpDesabilitadoNoStaging({ ...staging, KIDMAIS_DEPLOY_ENV }), /ambiente staging ou production/);
  }
});

test("produção exige Gupshup habilitado e não depende da trava de staging", () => {
  const production = { ...staging, KIDMAIS_DEPLOY_ENV: "production" };
  for (const GUPSHUP_OTP_ENABLED of [undefined, "false", "", "TRUE", "1"]) {
    assert.throws(() => modoOtpAmbiente({ ...production, GUPSHUP_OTP_ENABLED }), /GUPSHUP_OTP_ENABLED/);
  }
  for (const KIDMAIS_STAGING_OTP_DISABLED of [undefined, "SIM", "NAO"]) {
    const env = { ...production, GUPSHUP_OTP_ENABLED: "true", KIDMAIS_STAGING_OTP_DISABLED };
    assert.equal(modoOtpAmbiente(env), "gupshup");
    assert.equal(otpDesabilitadoNoStaging(env), false);
  }
  for (const NODE_ENV of ["production", "development"] as const) {
    assert.throws(() => modoOtpAmbiente({ ...production, NODE_ENV, IDENTIDADE_OTP_PROVIDER: "console" }), /não é permitido/);
    assert.throws(() => modoOtpAmbiente({ ...production, NODE_ENV, IDENTIDADE_OTP_PROVIDER: "disabled", KIDMAIS_STAGING_OTP_DISABLED: "SIM" }), /somente no staging/);
  }
});

test("liberação exige true exato e respeita a trava legada", () => {
  assert.equal(otpDesabilitadoNoStaging({ ...staging, GUPSHUP_OTP_ENABLED: "true" }), false);
  assert.equal(otpDesabilitadoNoStaging({
    ...staging, GUPSHUP_OTP_ENABLED: "true", KIDMAIS_STAGING_OTP_DISABLED: "SIM",
  }), true);
  for (const GUPSHUP_OTP_ENABLED of ["", "TRUE", "1", "SIM", " true "]) {
    assert.throws(() => modoOtpAmbiente({ ...staging, GUPSHUP_OTP_ENABLED }), /deve ser true ou false/);
  }
});
