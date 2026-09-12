import assert from "node:assert/strict";
import test from "node:test";

import {
  criarContratoAcessoToken,
  validarContratoAcessoToken,
} from "./acesso-token.ts";

const SECRET_ANTERIOR = process.env.IDENTIDADE_OTP_PEPPER;
process.env.IDENTIDADE_OTP_PEPPER = "kidmais-test-pepper-contrato-2026";

const CONTRATO_A = "11111111-1111-4111-8111-111111111111";
const CONTRATO_B = "22222222-2222-4222-8222-222222222222";
const VERSAO_A = "33333333-3333-4333-8333-333333333333";
const VALIDACAO_A = "44444444-4444-4444-8444-444444444444";

test.after(() => {
  if (SECRET_ANTERIOR === undefined) delete process.env.IDENTIDADE_OTP_PEPPER;
  else process.env.IDENTIDADE_OTP_PEPPER = SECRET_ANTERIOR;
});

test("token público fica vinculado ao Contrato, versão e validação que iniciaram o OTP", () => {
  const token = criarContratoAcessoToken({
    contratoId: CONTRATO_A,
    versaoId: VERSAO_A,
    validacaoId: VALIDACAO_A,
    ttlMs: 60_000,
  });

  const payload = validarContratoAcessoToken(token, {
    contratoId: CONTRATO_A,
    versaoId: VERSAO_A,
  });

  assert.equal(payload.validacaoId, VALIDACAO_A);
  assert.equal(payload.contratoId, CONTRATO_A);
  assert.equal(payload.versaoId, VERSAO_A);
});

test("token de um Contrato não autoriza outro Contrato do mesmo Cliente", () => {
  const token = criarContratoAcessoToken({
    contratoId: CONTRATO_A,
    versaoId: VERSAO_A,
    validacaoId: VALIDACAO_A,
    ttlMs: 60_000,
  });

  assert.throws(
    () => validarContratoAcessoToken(token, {
      contratoId: CONTRATO_B,
      versaoId: VERSAO_A,
    }),
    (error: unknown) => {
      return (
        error instanceof Error &&
        "code" in error &&
        error.code === "CONTRATO_ACESSO_NAO_AUTORIZADO"
      );
    },
  );
});

test("alteração no token invalida a assinatura HMAC", () => {
  const token = criarContratoAcessoToken({
    contratoId: CONTRATO_A,
    versaoId: VERSAO_A,
    validacaoId: VALIDACAO_A,
    ttlMs: 60_000,
  });

  const adulterado = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.throws(() => validarContratoAcessoToken(adulterado, {
    contratoId: CONTRATO_A,
    versaoId: VERSAO_A,
  }));
});
