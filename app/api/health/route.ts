import { db, databaseHealthCheck } from "@/lib/db/postgres";
import { validarAmbienteFesta } from "@/lib/festas/ambiente";
import { validarConfiguracaoOtpAmbiente } from "@/lib/identidade/delivery";
import {
  avaliarProntidao,
  linhasDiagnosticoStaging,
  respostaSaudeDisponivel,
} from "@/lib/saude/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

export async function GET() {
  const resultado = await avaliarProntidao({
    verificarDatabase: databaseHealthCheck,
    validarOtp: validarConfiguracaoOtpAmbiente,
    validarFesta: () => validarAmbienteFesta(db()),
    festaHabilitada: process.env.FESTA_ENABLED === "true",
  });

  if (!resultado.disponivel || !resultado.otp) {
    for (const linha of linhasDiagnosticoStaging(resultado)) {
      console.error(linha);
    }
    return Response.json(
      { ok: false, status: "unavailable" },
      { status: 503, headers },
    );
  }

  return Response.json(respostaSaudeDisponivel(resultado.otp), { headers });
}
