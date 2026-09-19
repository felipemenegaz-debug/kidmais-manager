export type ModoOtpAmbiente = "console" | "whatsapp_cloud" | "gupshup" | "disabled";

const FLAG_OTP_DESABILITADO_STAGING = "SIM";

export function modoOtpAmbiente(
  env: NodeJS.ProcessEnv = process.env,
): ModoOtpAmbiente {
  const provider = (env.IDENTIDADE_OTP_PROVIDER ?? "")
    .trim()
    .toLowerCase();

  if (provider === "console") {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "IDENTIDADE_OTP_PROVIDER=console não é permitido em produção.",
      );
    }
    return provider;
  }

  if (provider === "whatsapp_cloud") return provider;

  if (provider === "gupshup") {
    // Liberação deste provider limitada ao staging nesta etapa da integração.
    if (env.KIDMAIS_DEPLOY_ENV !== "staging") {
      throw new Error("IDENTIDADE_OTP_PROVIDER=gupshup é permitido somente no staging.");
    }
    const enabled = env.GUPSHUP_OTP_ENABLED;
    if (enabled !== undefined && enabled !== "true" && enabled !== "false") {
      throw new Error("GUPSHUP_OTP_ENABLED deve ser true ou false.");
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
    "IDENTIDADE_OTP_PROVIDER deve ser whatsapp_cloud em produção.",
  );
}

export function otpDesabilitadoNoStaging(
  env: NodeJS.ProcessEnv = process.env,
) {
  const provider = (env.IDENTIDADE_OTP_PROVIDER ?? "").trim().toLowerCase();
  if (provider === "gupshup") {
    modoOtpAmbiente(env);
    // Ausência da liberação é bloqueio. A trava legada tem precedência.
    return env.GUPSHUP_OTP_ENABLED !== "true" ||
      env.KIDMAIS_STAGING_OTP_DISABLED === FLAG_OTP_DESABILITADO_STAGING;
  }
  if (provider !== "disabled") {
    return false;
  }
  return modoOtpAmbiente(env) === "disabled";
}
