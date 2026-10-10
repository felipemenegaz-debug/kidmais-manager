import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { enviarOtpComAmbiente } from "@/lib/identidade/delivery";
import {
  criarIdentityServiceComAmbiente,
  isIdentityServiceError,
} from "@/lib/identidade/services";

import { db } from "@/lib/db/postgres";
import { escopoIdentidadePublica } from "@/lib/comercial/cotacao-publica";
import { limitarPublico, respostaRecusaPublica } from "@/lib/http/limite-publico";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const iniciarDesafioSchema = z
  .object({
    cpf: z.string().trim().min(1).max(32),
    canal: z.literal("WHATSAPP"),
  })
  .strict();

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: NextRequest) {
  const limite = limitarPublico(request, "IDENTIDADE");
  if (limite) return limite;
  // Empresa pelo endereço (servidor): CPF só é procurado nela; nunca em cadastro de outra empresa.
  let escopo: Awaited<ReturnType<typeof escopoIdentidadePublica>>;
  try {
    escopo = await escopoIdentidadePublica(db, request.nextUrl);
  } catch (error) {
    return respostaRecusaPublica(error);
  }
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

  const dados = iniciarDesafioSchema.safeParse(body);

  if (!dados.success) {
    return noStore(
      NextResponse.json(
        {
          ok: false,
          erro: "Dados inválidos para iniciar a validação.",
          codigo: "DADOS_INVALIDOS",
          detalhes: dados.error.flatten(),
        },
        { status: 400 },
      ),
    );
  }

  try {
    const service = criarIdentityServiceComAmbiente(enviarOtpComAmbiente);
    const desafio = await service.iniciarDesafio({
      cpf: dados.data.cpf,
      canal: dados.data.canal,
      escopo,
    });

    return noStore(
      NextResponse.json(
        {
          ok: true,
          validacaoId: desafio.validacaoId,
          canal: desafio.canal,
          destinoMascarado: desafio.destinoMascarado,
          expiraEm: desafio.expiraEm,
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
      "[Kidmais Identidade API] erro não tratado ao iniciar desafio",
      error,
    );

    return noStore(
      NextResponse.json(
        {
          ok: false,
          erro: "Não foi possível iniciar a validação agora.",
          codigo: "ERRO_INICIAR_VALIDACAO",
        },
        { status: 500 },
      ),
    );
  }
}
