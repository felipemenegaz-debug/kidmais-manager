import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { camposDocumentoPublico, documentoInformado, MENSAGEM_SEM_DOCUMENTO, temDocumento } from "@/lib/identidade/documento-rota";
import { iniciarDesafioContrato } from "@/lib/contratos/services";
import { enviarOtpComAmbiente } from "@/lib/identidade/delivery";
import {
  contratoIdDaRota,
  erroContratoPublico,
  noStoreContrato,
  type ContratoRouteContext,
} from "../../../route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  ...camposDocumentoPublico,
  // EMAIL só é aceito pelo serviço quando a reserva está ligada e o cliente não tem WhatsApp.
  canal: z.enum(["WHATSAPP", "EMAIL"]),
}).strict().refine(temDocumento, MENSAGEM_SEM_DOCUMENTO);

export async function POST(request: NextRequest, context: ContratoRouteContext) {
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
    const data = await iniciarDesafioContrato(
      { contratoId, cpf: documentoInformado(body), canal: body.canal },
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
