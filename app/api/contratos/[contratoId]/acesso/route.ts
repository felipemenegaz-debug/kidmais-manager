import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { consultarAcessoContrato } from "@/lib/contratos/services";
import {
  contratoIdDaRota,
  erroContratoPublico,
  noStoreContrato,
  type ContratoRouteContext,
} from "../../route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ cpf: z.string().trim().min(1).max(32) }).strict();

export async function POST(request: NextRequest, context: ContratoRouteContext) {
  try {
    const contratoId = z.string().uuid().parse(await contratoIdDaRota(context));
    const body = schema.parse(await request.json());
    const data = await consultarAcessoContrato({ contratoId, cpf: body.cpf });
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
