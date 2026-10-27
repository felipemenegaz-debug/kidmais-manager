import type { NextRequest } from "next/server";
import { respostaListaSaloes } from "@/lib/agenda/salao-publico-rotas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** S-D: salões prontos do escopo público para um horário (tela "Conheça os salões"). */
export async function GET(request: NextRequest) {
  return respostaListaSaloes(request);
}
