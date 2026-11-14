import assert from "node:assert/strict";
import test from "node:test";

import type { MensagemEmail } from "../../acessos/email.ts";
import { reservaEmailOtpDisponivel, reservaEmailOtpLigada } from "../configuracao-otp.ts";
import type { OtpDelivery } from "../services/models.ts";
import { criarEmailOtpSender, mensagemCodigoOtpEmail } from "./email.sender.ts";
import { enviarOtpComAmbiente, validarConfiguracaoOtpAmbiente } from "./otp.sender.ts";

const ligada = (env: Record<string, string>) => reservaEmailOtpLigada(env as NodeJS.ProcessEnv);
const disponivel = (env: Record<string, string>) => reservaEmailOtpDisponivel(env as NodeJS.ProcessEnv);
const agora = new Date("2026-11-12T12:00:00.000Z");
const delivery: OtpDelivery = {
  validacaoId: "11111111-1111-4111-8111-111111111111",
  canal: "EMAIL",
  destino: "cliente@exemplo.test",
  codigo: "042917",
  expiraEm: "2026-11-12T12:10:00.000Z",
};

function comEnv<T>(valores: Record<string, string | undefined>, fn: () => T): T {
  const env = process.env as Record<string, string | undefined>;
  const anteriores = Object.fromEntries(Object.keys(valores).map((k) => [k, env[k]]));
  try {
    for (const [k, v] of Object.entries(valores)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(anteriores)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
}

test("trava IDENTIDADE_OTP_EMAIL_RESERVA: desligada por padrão, só 'ligado' liga, valor desconhecido é erro", () => {
  assert.equal(ligada({}), false);
  assert.equal(ligada({ IDENTIDADE_OTP_EMAIL_RESERVA: "desligado" }), false);
  assert.equal(ligada({ IDENTIDADE_OTP_EMAIL_RESERVA: " Ligado " }), true);
  for (const valor of ["sim", "true", "1", "on"]) {
    assert.throws(() => ligada({ IDENTIDADE_OTP_EMAIL_RESERVA: valor }), /ligado ou desligado/);
  }
});

test("reserva disponível exige a trava ligada E o e-mail configurado", () => {
  const resend = { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_teste", EMAIL_REMETENTE: "iA.Fest <nao-responda@exemplo.test>" };
  assert.equal(disponivel({ ...resend }), false);
  assert.equal(disponivel({ ...resend, IDENTIDADE_OTP_EMAIL_RESERVA: "ligado" }), true);
  assert.equal(disponivel({ IDENTIDADE_OTP_EMAIL_RESERVA: "ligado" }), false);
  assert.equal(disponivel({ IDENTIDADE_OTP_EMAIL_RESERVA: "ligado", EMAIL_PROVIDER: "resend" }), false);
  // Provedor de arquivo nunca vale em deploy.
  assert.equal(
    disponivel({ IDENTIDADE_OTP_EMAIL_RESERVA: "ligado", EMAIL_PROVIDER: "arquivo", EMAIL_ARQUIVO_DIR: "D:/tmp", KIDMAIS_DEPLOY_ENV: "staging" }),
    false,
  );
});

test("mensagem do código: assunto, validade, aviso de não compartilhar e chave idempotente pela validação", () => {
  const msg = mensagemCodigoOtpEmail(delivery, agora);
  assert.equal(msg.para, "cliente@exemplo.test");
  assert.equal(msg.assunto, "Seu código do iA.Fest: 042917");
  assert.match(msg.texto, /042917/);
  assert.match(msg.texto, /10 minutos/);
  assert.match(msg.texto, /Não compartilhe/);
  assert.match(msg.html, /042917/);
  assert.equal(msg.idempotencia, `otp-email:${delivery.validacaoId}`);
  assert.throws(() => mensagemCodigoOtpEmail({ ...delivery, codigo: "12a456" }, agora), /inválido/);
});

test("emissor por e-mail: só canal EMAIL, destino e validação válidos; erro genérico sem destino nem código", async () => {
  const enviados: MensagemEmail[] = [];
  const ok = criarEmailOtpSender(async (m) => { enviados.push(m); return { provedor: "arquivo", idExterno: null }; }, () => agora);
  await ok({ ...delivery, destino: "  cliente@exemplo.test " });
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].para, "cliente@exemplo.test");

  await assert.rejects(ok({ ...delivery, canal: "WHATSAPP" }), /somente o canal EMAIL/);
  await assert.rejects(ok({ ...delivery, destino: "sem-arroba" }), /Destino de e-mail inválido/);
  await assert.rejects(ok({ ...delivery, validacaoId: "../x" }), /Validação inválida/);
  assert.equal(enviados.length, 1);

  const falha = criarEmailOtpSender(async () => { throw new Error(`recusado para ${delivery.destino} código ${delivery.codigo}`); }, () => agora);
  await assert.rejects(falha(delivery), (erro: Error) => {
    assert.equal(erro.message, "O envio do código por e-mail falhou.");
    return true;
  });
});

test("envio do ambiente: canal EMAIL recusado quando a reserva está desligada ou sem e-mail configurado", async () => {
  for (const valores of [
    { IDENTIDADE_OTP_EMAIL_RESERVA: undefined, EMAIL_PROVIDER: undefined },
    { IDENTIDADE_OTP_EMAIL_RESERVA: "ligado", EMAIL_PROVIDER: undefined },
    { IDENTIDADE_OTP_EMAIL_RESERVA: undefined, EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_teste", EMAIL_REMETENTE: "x@exemplo.test" },
  ]) {
    await comEnv(valores, () =>
      assert.rejects(enviarOtpComAmbiente(delivery), /e-mail indisponível neste ambiente/),
    );
  }
});

test("health: reserva desligada não muda o status; ligada informa ready/unavailable sem valores", () => {
  const base = { NODE_ENV: "development", KIDMAIS_DEPLOY_ENV: undefined, IDENTIDADE_OTP_PROVIDER: "console" };
  comEnv({ ...base, IDENTIDADE_OTP_EMAIL_RESERVA: undefined }, () => {
    assert.deepEqual(validarConfiguracaoOtpAmbiente(), { provider: "console", status: "ready" });
  });
  comEnv({ ...base, IDENTIDADE_OTP_EMAIL_RESERVA: "ligado", EMAIL_PROVIDER: undefined }, () => {
    assert.deepEqual(validarConfiguracaoOtpAmbiente(), { provider: "console", status: "ready", emailFallback: "unavailable" });
  });
  comEnv({ ...base, IDENTIDADE_OTP_EMAIL_RESERVA: "ligado", EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_segredo", EMAIL_REMETENTE: "x@exemplo.test" }, () => {
    const status = validarConfiguracaoOtpAmbiente();
    assert.deepEqual(status, { provider: "console", status: "ready", emailFallback: "ready" });
    assert.doesNotMatch(JSON.stringify(status), /re_segredo|exemplo/);
  });
  comEnv({ ...base, IDENTIDADE_OTP_EMAIL_RESERVA: "talvez" }, () => {
    assert.throws(validarConfiguracaoOtpAmbiente, /ligado ou desligado/);
  });
});
