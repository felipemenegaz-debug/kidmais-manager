import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { receberCodigoContratoPorEmail } from "@/lib/contratos/services";
import { enviarOtpComAmbiente } from "@/lib/identidade/delivery";
import { limitarPublico } from "@/lib/http/limite-publico";
import {
  contratoIdDaRota,
  erroContratoPublico,
  noStoreContrato,
  type ContratoRouteContext,
} from "../../../route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** O acesso do desafio do WhatsApp (devolvido só a quem iniciou) autoriza trocar pelo código no e-mail do cadastro. */
const schema = z.object({
  acessoToken: z.string().min(1).max(4096),
}).strict();

export async function POST(request: NextRequest, context: ContratoRouteContext) {
  const limite = await limitarPublico(request, "IDENTIDADE");
  if (limite) return noStoreContrato(limite);
  try {
    const contratoId = z.string().uuid().parse(await contratoIdDaRota(context));
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return noStoreContrato(
        NextResponse.json(
          { ok: false, erro: "Corpo JSON inválido.", codigo: "JSON_INVALIDO" },
          { status: 400 },
        ),
      );
    }
    const body = schema.parse(json);
    const data = await receberCodigoContratoPorEmail(
      { contratoId, acessoToken: body.acessoToken },
      enviarOtpComAmbiente,
    );
    return noStoreContrato(NextResponse.json({ ok: true, data }, { status: 201 }));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return noStoreContrato(
        NextResponse.json(
          { ok: false, erro: "Dados inválidos.", codigo: "DADOS_INVALIDOS" },
          { status: 400 },
        ),
      );
    }
    return erroContratoPublico(error);
  }
}
