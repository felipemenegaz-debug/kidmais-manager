import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { enviarOtpComAmbiente } from "@/lib/identidade/delivery";
import {
  criarIdentityServiceComAmbiente,
  isIdentityServiceError,
} from "@/lib/identidade/services";
import { limitarPublico } from "@/lib/http/limite-publico";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Não recebeu? Receber por e-mail": troca o desafio pendente do WhatsApp por um código novo no e-mail do cadastro.
 * Como em confirmar-codigo, o validacaoId (devolvido só a quem iniciou) é a capacidade; o destino nunca vem do pedido.
 */
const receberPorEmailSchema = z
  .object({
    validacaoId: z.string().uuid(),
  })
  .strict();

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: NextRequest) {
  const limite = await limitarPublico(request, "IDENTIDADE");
  if (limite) return limite;

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

  const dados = receberPorEmailSchema.safeParse(body);
  if (!dados.success) {
    return noStore(
      NextResponse.json(
        {
          ok: false,
          erro: "Dados inválidos para receber o código por e-mail.",
          codigo: "DADOS_INVALIDOS",
        },
        { status: 400 },
      ),
    );
  }

  try {
    const service = criarIdentityServiceComAmbiente(enviarOtpComAmbiente);
    const desafio = await service.receberCodigoPorEmail(dados.data.validacaoId);

    return noStore(
      NextResponse.json(
        {
          ok: true,
          validacaoId: desafio.validacaoId,
          canal: desafio.canal,
          destinoMascarado: desafio.destinoMascarado,
          expiraEm: desafio.expiraEm,
          reserva: desafio.reserva,
        },
        { status: 201 },
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
      "[Kidmais Identidade API] erro não tratado ao enviar o código por e-mail",
      error,
    );

    return noStore(
      NextResponse.json(
        {
          ok: false,
          erro: "Não foi possível enviar o código por e-mail agora.",
          codigo: "ERRO_RECEBER_POR_EMAIL",
        },
        { status: 500 },
      ),
    );
  }
}
