import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z
  .object({
    cep: z.string().trim().min(1).max(16),
  })
  .strict();

type ViaCepResponse = {
  cep?: string;
  logradouro?: string;
  bairro?: string;
  localidade?: string;
  uf?: string;
  erro?: boolean | "true";
};

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function somenteDigitos(valor: string) {
  return valor.replace(/\D/g, "");
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
        { ok: false, erro: "Informe um CEP válido.", codigo: "DADOS_INVALIDOS" },
        { status: 400 },
      ),
    );
  }

  const cep = somenteDigitos(parsed.data.cep);
  if (!/^\d{8}$/.test(cep)) {
    return noStore(
      NextResponse.json(
        { ok: false, erro: "Informe um CEP com 8 dígitos.", codigo: "CEP_INVALIDO" },
        { status: 400 },
      ),
    );
  }

  try {
    const resposta = await fetch(`https://viacep.com.br/ws/${cep}/json/`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });

    if (!resposta.ok) {
      throw new Error(`ViaCEP respondeu HTTP ${resposta.status}.`);
    }

    const endereco = (await resposta.json()) as ViaCepResponse;

    if (endereco.erro === true || endereco.erro === "true") {
      return noStore(
        NextResponse.json(
          { ok: false, erro: "CEP não encontrado.", codigo: "CEP_NAO_ENCONTRADO" },
          { status: 404 },
        ),
      );
    }

    return noStore(
      NextResponse.json(
        {
          ok: true,
          cep,
          logradouro: endereco.logradouro?.trim() ?? "",
          bairro: endereco.bairro?.trim() ?? "",
          cidade: endereco.localidade?.trim() ?? "",
          uf: endereco.uf?.trim().toUpperCase() ?? "",
        },
        { status: 200 },
      ),
    );
  } catch (error) {
    console.error("[Kidmais Endereço API] erro ao consultar CEP", error);
    return noStore(
      NextResponse.json(
        {
          ok: false,
          erro: "Não foi possível consultar o CEP agora. Preencha o endereço manualmente.",
          codigo: "SERVICO_CEP_INDISPONIVEL",
        },
        { status: 503 },
      ),
    );
  }
}
