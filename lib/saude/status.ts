import type { StatusOtpAmbiente } from "../identidade/delivery/otp.sender";

type EstadoComponente = "ready" | "failed" | "unavailable";

type DiagnosticoComponente = {
  status: EstadoComponente;
  codigo?:
    | "DATABASE_CONNECTION_FAILED"
    | "FESTA_DATABASE_UNAVAILABLE"
    | "FESTA_DISABLED"
    | "FESTA_INSTALLATION_NOT_VALIDATED"
    | "OTP_STAGING_DISABLED_EXPECTED"
    | "OTP_CONFIG_INVALID";
};

export type ResultadoProntidao = {
  disponivel: boolean;
  otp?: StatusOtpAmbiente;
  componentes: {
    database: DiagnosticoComponente;
    festa: DiagnosticoComponente;
    otp: DiagnosticoComponente;
  };
};

type DependenciasProntidao = {
  verificarDatabase: () => Promise<boolean>;
  validarFesta: () => Promise<void>;
  validarOtp: () => StatusOtpAmbiente;
  festaHabilitada: boolean;
};

export async function avaliarProntidao({
  verificarDatabase,
  validarFesta,
  validarOtp,
  festaHabilitada,
}: DependenciasProntidao): Promise<ResultadoProntidao> {
  let database: DiagnosticoComponente = {
    status: "failed",
    codigo: "DATABASE_CONNECTION_FAILED",
  };
  try {
    if (await verificarDatabase()) database = { status: "ready" };
  } catch {
    // O diagnóstico público e os logs não recebem detalhes da conexão.
  }

  let otp: StatusOtpAmbiente | undefined;
  let diagnosticoOtp: DiagnosticoComponente = {
    status: "failed",
    codigo: "OTP_CONFIG_INVALID",
  };
  try {
    otp = validarOtp();
    diagnosticoOtp =
      otp.status === "unavailable"
        ? {
            status: "unavailable",
            codigo: "OTP_STAGING_DISABLED_EXPECTED",
          }
        : { status: "ready" };
  } catch {
    // Não registrar mensagens que possam conter configuração do provedor.
  }

  let festa: DiagnosticoComponente;
  if (database.status !== "ready") {
    festa = {
      status: "failed",
      codigo: "FESTA_DATABASE_UNAVAILABLE",
    };
  } else if (!festaHabilitada) {
    festa = { status: "failed", codigo: "FESTA_DISABLED" };
  } else {
    try {
      await validarFesta();
      festa = { status: "ready" };
    } catch {
      festa = {
        status: "failed",
        codigo: "FESTA_INSTALLATION_NOT_VALIDATED",
      };
    }
  }

  return {
    disponivel:
      database.status === "ready" &&
      festa.status === "ready" &&
      diagnosticoOtp.status !== "failed",
    otp,
    componentes: { database, festa, otp: diagnosticoOtp },
  };
}

export function linhasDiagnosticoStaging(
  resultado: ResultadoProntidao,
  env: { KIDMAIS_DEPLOY_ENV?: string } = {
    KIDMAIS_DEPLOY_ENV: process.env.KIDMAIS_DEPLOY_ENV,
  },
) {
  if (env.KIDMAIS_DEPLOY_ENV !== "staging" || resultado.disponivel) return [];

  return (Object.entries(resultado.componentes) as Array<
    [keyof ResultadoProntidao["componentes"], DiagnosticoComponente]
  >).map(
    ([nome, componente]) =>
      `[Kidmais Health] ${nome}=${componente.status}${componente.codigo ? ` code=${componente.codigo}` : ""}`,
  );
}

export function respostaSaudeDisponivel(otp: StatusOtpAmbiente) {
  const detalhesOtp =
    otp.provider === "gupshup"
      ? {
          otp: {
            provider: "gupshup" as const,
            configured: otp.configured === true,
            enabled: otp.enabled === true,
            ...(otp.reason === "staging_disabled"
              ? { reason: "staging_disabled" as const }
              : {}),
          },
        }
      : {};

  if (otp.status === "unavailable") {
    return {
      ok: true as const,
      status: "degraded" as const,
      components: {
        database: "ready" as const,
        festa: "ready" as const,
        otp: "unavailable" as const,
      },
      ...detalhesOtp,
    };
  }

  return {
    ok: true as const,
    status: "ready" as const,
    components: {
      database: "ready" as const,
      festa: "ready" as const,
      otp: "ready" as const,
    },
    ...detalhesOtp,
  };
}
