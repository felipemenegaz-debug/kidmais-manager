import { db, databaseHealthCheck } from "@/lib/db/postgres";
import { validarAmbienteFesta } from "@/lib/festas/ambiente";
import { validarConfiguracaoOtpAmbiente } from "@/lib/identidade/delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    if (!(await databaseHealthCheck())) {
      throw new Error("Banco indisponível");
    }

    validarConfiguracaoOtpAmbiente();
    await validarAmbienteFesta(db());
    return Response.json({ ok: true, status: "ready" }, { headers });
  } catch (error) {
    console.error(
      "[Kidmais Health] verificação de prontidão recusada",
      error instanceof Error ? error.name : "Erro",
    );
    return Response.json(
      { ok: false, status: "unavailable" },
      { status: 503, headers },
    );
  }
}
