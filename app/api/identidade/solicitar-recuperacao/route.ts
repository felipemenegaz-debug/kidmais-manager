import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { enviarOtpComAmbiente } from "@/lib/identidade/delivery";
import {
  criarIdentityServiceComAmbiente,
  isIdentityServiceError,
} from "@/lib/identidade/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ cpf: z.string().trim().min(1).max(32) }).strict();

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(
      NextResponse.json(
        { ok: false, erro: "Corpo JSON inválido.", codigo: "JSON_INVALIDO" },
        { status: 400 },
      ),
    );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return noStore(
      NextResponse.json(
        { ok: false, erro: "Informe um CPF válido.", codigo: "DADOS_INVALIDOS" },
        { status: 400 },
      ),
    );
  }

  try {
    const service = criarIdentityServiceComAmbiente(enviarOtpComAmbiente);
    const result = await service.solicitarRecuperacao(parsed.data.cpf);

    return noStore(NextResponse.json({ ok: true, ...result }, { status: 202 }));
  } catch (error) {
    if (isIdentityServiceError(error)) {
      return noStore(
        NextResponse.json(
          { ok: false, erro: error.message, codigo: error.code },
          { status: error.httpStatus },
        ),
      );
    }

    console.error("[Kidmais Identidade API] erro ao solicitar recuperação", error);
    return noStore(
      NextResponse.json(
        {
          ok: false,
          erro: "Não foi possível registrar a validação pendente agora.",
          codigo: "ERRO_RECUPERACAO_IDENTIDADE",
        },
        { status: 500 },
      ),
    );
  }
}
