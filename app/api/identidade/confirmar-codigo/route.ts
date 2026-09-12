import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { enviarOtpComAmbiente } from "@/lib/identidade/delivery";
import {
  criarIdentityServiceComAmbiente,
  isIdentityServiceError,
} from "@/lib/identidade/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const confirmarCodigoSchema = z
  .object({
    validacaoId: z.string().uuid(),
    codigo: z.string().trim().regex(/^\d{6}$/),
  })
  .strict();

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
        {
          ok: false,
          erro: "Corpo JSON inválido.",
          codigo: "JSON_INVALIDO",
        },
        { status: 400 },
      ),
    );
  }

  const dados = confirmarCodigoSchema.safeParse(body);

  if (!dados.success) {
    return noStore(
      NextResponse.json(
        {
          ok: false,
          erro: "Dados inválidos para confirmar a validação.",
          codigo: "DADOS_INVALIDOS",
          detalhes: dados.error.flatten(),
        },
        { status: 400 },
      ),
    );
  }

  try {
    const service = criarIdentityServiceComAmbiente(enviarOtpComAmbiente);

    const prova = await service.confirmarCodigo({
      validacaoId: dados.data.validacaoId,
      codigo: dados.data.codigo,
    });

    return noStore(
      NextResponse.json(
        {
          ok: true,
          provaToken: prova.provaToken,
          expiraEm: prova.expiraEm,
        },
        { status: 200 },
      ),
    );
  } catch (error) {
    if (isIdentityServiceError(error)) {
      return noStore(
        NextResponse.json(
          {
            ok: false,
            erro: error.message,
            codigo: error.code,
            detalhes:
              error.httpStatus < 500 ? (error.details ?? null) : undefined,
          },
          { status: error.httpStatus },
        ),
      );
    }

    console.error(
      "[Kidmais Identidade API] erro não tratado ao confirmar código",
      error,
    );

    return noStore(
      NextResponse.json(
        {
          ok: false,
          erro: "Não foi possível confirmar a validação agora.",
          codigo: "ERRO_CONFIRMAR_VALIDACAO",
        },
        { status: 500 },
      ),
    );
  }
}
