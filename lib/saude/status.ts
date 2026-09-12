import type { StatusOtpAmbiente } from "../identidade/delivery/otp.sender";

export function respostaSaudeDisponivel(otp: StatusOtpAmbiente) {
  if (otp.status === "unavailable") {
    return {
      ok: true as const,
      status: "degraded" as const,
      components: {
        database: "ready" as const,
        festa: "ready" as const,
        otp: "unavailable" as const,
      },
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
  };
}
