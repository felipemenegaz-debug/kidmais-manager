import assert from "node:assert/strict";
import test from "node:test";
import { modoOtpAmbiente, otpDesabilitadoNoStaging } from "./configuracao-otp.ts";

const staging: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  KIDMAIS_DEPLOY_ENV: "staging",
  IDENTIDADE_OTP_PROVIDER: "gupshup",
};

test("Gupshup é restrito ao staging e fica bloqueado por padrão", () => {
  assert.equal(modoOtpAmbiente(staging), "gupshup");
  assert.equal(otpDesabilitadoNoStaging(staging), true);
  assert.equal(otpDesabilitadoNoStaging({ ...staging, GUPSHUP_OTP_ENABLED: "false" }), true);
  for (const KIDMAIS_DEPLOY_ENV of [undefined, "production", "local"]) {
    assert.throws(() => modoOtpAmbiente({ ...staging, KIDMAIS_DEPLOY_ENV }), /somente no staging/);
    assert.throws(() => otpDesabilitadoNoStaging({ ...staging, KIDMAIS_DEPLOY_ENV }), /somente no staging/);
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
