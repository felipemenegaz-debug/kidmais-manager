import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { obterClienteBase } from "@/lib/clientes/services";
import { enviarOtpComAmbiente } from "@/lib/identidade/delivery";
import {
  criarIdentityServiceComAmbiente,
  isIdentityServiceError,
} from "@/lib/identidade/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z
  .object({
    provaToken: z.string().trim().min(32).max(512),
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
        { ok: false, erro: "Corpo JSON inválido.", codigo: "JSON_INVALIDO" },
        { status: 400 },
      ),
    );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return noStore(
      NextResponse.json(
        { ok: false, erro: "Prova de identidade inválida.", codigo: "DADOS_INVALIDOS" },
        { status: 400 },
      ),
    );
  }

  try {
    const service = criarIdentityServiceComAmbiente(enviarOtpComAmbiente);
    const resolvida = await service.resolverClientePorProva(parsed.data.provaToken);
    const base = await obterClienteBase(resolvida.clienteId);

    return noStore(
      NextResponse.json(
        {
          ok: true,
          cliente: {
            nomeCompleto: base.cliente.nomeCompleto,
            cpf: base.cliente.cpf,
            rg: base.cliente.rg,
            telefone: base.cliente.telefone,
            whatsapp: base.cliente.whatsapp,
            email: base.cliente.email,
            cep: base.cliente.cep,
            logradouro: base.cliente.logradouro,
            numero: base.cliente.numero,
            complemento: base.cliente.complemento,
            bairro: base.cliente.bairro,
            cidade: base.cliente.cidade,
            uf: base.cliente.uf,
          },
          aniversariantes: base.aniversariantes.map((item) => ({
            id: item.id,
            nome: item.nome,
            dataNascimento: item.dataNascimento,
            temaPadrao: item.temaPadrao,
          })),
          cadastro: base.cadastro,
          provaExpiraEm: resolvida.expiraEm,
        },
        { status: 200 },
      ),
    );
  } catch (error) {
    if (isIdentityServiceError(error)) {
      return noStore(
        NextResponse.json(
          { ok: false, erro: error.message, codigo: error.code },
          { status: error.httpStatus },
        ),
      );
    }

    console.error("[Kidmais Identidade API] erro ao carregar contexto validado", error);
    return noStore(
      NextResponse.json(
        {
          ok: false,
          erro: "Não foi possível carregar o cadastro validado.",
          codigo: "ERRO_CONTEXTO_IDENTIDADE",
        },
        { status: 500 },
      ),
    );
  }
}
