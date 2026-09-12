import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { obterContextoContratoPublico } from "@/lib/contratos/services";
import {
  contratoIdDaRota,
  erroContratoPublico,
  noStoreContrato,
  type ContratoRouteContext,
} from "../../route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  provaToken: z.string().trim().min(32).max(512),
  acessoToken: z.string().trim().min(32).max(2048),
}).strict();

export async function POST(request: NextRequest, context: ContratoRouteContext) {
  try {
    const contratoId = z.string().uuid().parse(await contratoIdDaRota(context));
    const body = schema.parse(await request.json());
    const data = await obterContextoContratoPublico({ contratoId, provaToken: body.provaToken, acessoToken: body.acessoToken });
    return noStoreContrato(NextResponse.json({ ok: true, data }));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return noStoreContrato(
        NextResponse.json(
          { ok: false, erro: "Prova ou Contrato inválidos.", codigo: "DADOS_INVALIDOS" },
          { status: 400 },
        ),
      );
    }
    return erroContratoPublico(error);
  }
}
