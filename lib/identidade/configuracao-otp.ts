import { situacaoEmail } from "../acessos/email.ts";

export type ModoOtpAmbiente = "console" | "whatsapp_cloud" | "gupshup" | "disabled";

const FLAG_OTP_DESABILITADO_STAGING = "SIM";

export function modoOtpAmbiente(
  env: NodeJS.ProcessEnv = process.env,
): ModoOtpAmbiente {
  const provider = (env.IDENTIDADE_OTP_PROVIDER ?? "")
    .trim()
    .toLowerCase();

  if (provider === "console") {
    if (env.NODE_ENV === "production" || env.KIDMAIS_DEPLOY_ENV === "production") {
      throw new Error(
        "IDENTIDADE_OTP_PROVIDER=console não é permitido em produção.",
      );
    }
    return provider;
  }

  if (provider === "whatsapp_cloud") return provider;

  if (provider === "gupshup") {
    if (env.KIDMAIS_DEPLOY_ENV !== "staging" && env.KIDMAIS_DEPLOY_ENV !== "production") {
      throw new Error("IDENTIDADE_OTP_PROVIDER=gupshup exige ambiente staging ou production explícito.");
    }
    const enabled = env.GUPSHUP_OTP_ENABLED;
    if (enabled !== undefined && enabled !== "true" && enabled !== "false") {
      throw new Error("GUPSHUP_OTP_ENABLED deve ser true ou false.");
    }
    if (env.KIDMAIS_DEPLOY_ENV === "production" && enabled !== "true") {
      throw new Error("GUPSHUP_OTP_ENABLED deve ser true em produção.");
    }
    return provider;
  }

  if (provider === "disabled") {
    if (
      env.NODE_ENV !== "production" ||
      env.KIDMAIS_DEPLOY_ENV !== "staging" ||
      env.KIDMAIS_STAGING_OTP_DISABLED !== FLAG_OTP_DESABILITADO_STAGING
    ) {
      throw new Error(
        "IDENTIDADE_OTP_PROVIDER=disabled é permitido somente no staging explicitamente autorizado.",
      );
    }
    return provider;
  }

  throw new Error(
    "IDENTIDADE_OTP_PROVIDER deve ser whatsapp_cloud ou gupshup em produção.",
  );
}

/**
 * Reserva por e-mail do código (decisão de Felipe, 12/11/2026): quando o WhatsApp falha, o código vai para o e-mail do
 * cadastro do cliente. Desligada por padrão; só `ligado` liga. Valor desconhecido é erro de configuração (fail-closed).
 * Ligada aqui não basta: o envio de e-mail também precisa estar configurado (ver `reservaEmailOtpDisponivel`).
 */
export function reservaEmailOtpLigada(env: NodeJS.ProcessEnv = process.env) {
  const valor = (env.IDENTIDADE_OTP_EMAIL_RESERVA ?? "").trim().toLowerCase();
  if (valor === "" || valor === "desligado") return false;
  if (valor === "ligado") return true;
  throw new Error("IDENTIDADE_OTP_EMAIL_RESERVA deve ser ligado ou desligado.");
}

export function otpDesabilitadoNoStaging(
  env: NodeJS.ProcessEnv = process.env,
) {
  const provider = (env.IDENTIDADE_OTP_PROVIDER ?? "").trim().toLowerCase();
  if (provider === "gupshup") {
    modoOtpAmbiente(env);
    // A trava legada se aplica exclusivamente ao staging.
    return env.GUPSHUP_OTP_ENABLED !== "true" ||
      (env.KIDMAIS_DEPLOY_ENV === "staging" &&
        env.KIDMAIS_STAGING_OTP_DISABLED === FLAG_OTP_DESABILITADO_STAGING);
  }
  if (provider !== "disabled") {
    return false;
  }
  return modoOtpAmbiente(env) === "disabled";
}

/** Reserva ligada E envio de e-mail configurado (sem expor valores). Só então o e-mail é oferecido ao cliente. */
export function reservaEmailOtpDisponivel(env: NodeJS.ProcessEnv = process.env) {
  return reservaEmailOtpLigada(env) && situacaoEmail(env).configurado;
}
