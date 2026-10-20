import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  consultarCpfPublico,
  isIdentityServiceError,
} from "@/lib/identidade/services";

import { db } from "@/lib/db/postgres";
import { escopoIdentidadePublica } from "@/lib/comercial/cotacao-publica";
import { limitarPublico, respostaRecusaPublica } from "@/lib/http/limite-publico";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const consultarCpfSchema = z
  .object({
    cpf: z.string().trim().min(1).max(32),
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

  const dados = consultarCpfSchema.safeParse(body);

  if (!dados.success) {
    return noStore(
      NextResponse.json(
        {
          ok: false,
          erro: "Informe um CPF válido.",
          codigo: "DADOS_INVALIDOS",
          detalhes: dados.error.flatten(),
        },
        { status: 400 },
      ),
    );
  }

  try {
    const resultado = await consultarCpfPublico(dados.data.cpf, escopo);

    return noStore(
      NextResponse.json(
        {
          ok: true,
          situacao: resultado.situacao,
          canais: resultado.canais,
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
            detalhes: error.details ?? null,
          },
          { status: error.httpStatus },
        ),
      );
    }

    console.error("[Kidmais Identidade API] erro não tratado", error);

    return noStore(
      NextResponse.json(
        {
          ok: false,
          erro: "Não foi possível consultar a identidade agora.",
          codigo: "ERRO_CONSULTA_IDENTIDADE",
        },
        { status: 500 },
      ),
    );
  }
}
