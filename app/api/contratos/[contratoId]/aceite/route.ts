import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assinarContratoPublico } from "@/lib/contratos/services";
import { enviarOtpComAmbiente } from "@/lib/identidade/delivery";
import {
  contextoContratoPublicoDaRequest,
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
  versaoId: z.string().uuid(),
  snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
  documentoPdfHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export async function POST(request: NextRequest, context: ContratoRouteContext) {
  try {
    const contratoId = z.string().uuid().parse(await contratoIdDaRota(context));
    const body = schema.parse(await request.json());
    const data = await assinarContratoPublico(
      { contratoId, ...body },
      enviarOtpComAmbiente,
      contextoContratoPublicoDaRequest(request),
    );
    return noStoreContrato(NextResponse.json({ ok: true, data }));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return noStoreContrato(
        NextResponse.json(
          { ok: false, erro: "Dados inválidos para o aceite.", codigo: "DADOS_INVALIDOS" },
          { status: 400 },
        ),
      );
    }
    return erroContratoPublico(error);
  }
}
