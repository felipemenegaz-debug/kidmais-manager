export type ModoOtpAmbiente = "console" | "whatsapp_cloud" | "disabled";

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
  if ((env.IDENTIDADE_OTP_PROVIDER ?? "").trim().toLowerCase() !== "disabled") {
    return false;
  }
  return modoOtpAmbiente(env) === "disabled";
}
