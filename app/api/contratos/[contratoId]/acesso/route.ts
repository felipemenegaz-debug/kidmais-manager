import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { camposDocumentoPublico, documentoInformado, MENSAGEM_SEM_DOCUMENTO, temDocumento } from "@/lib/identidade/documento-rota";
import { consultarAcessoContrato } from "@/lib/contratos/services";
import {
  contratoIdDaRota,
  erroContratoPublico,
  noStoreContrato,
  type ContratoRouteContext,
} from "../../route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object(camposDocumentoPublico).strict().refine(temDocumento, MENSAGEM_SEM_DOCUMENTO);

export async function POST(request: NextRequest, context: ContratoRouteContext) {
  try {
    const contratoId = z.string().uuid().parse(await contratoIdDaRota(context));
    const body = schema.parse(await request.json());
    const data = await consultarAcessoContrato({ contratoId, cpf: documentoInformado(body) });
    return noStoreContrato(NextResponse.json({ ok: true, data }));
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
