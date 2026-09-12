import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { gerarResumoContratoPublico } from "@/lib/contratos/services";
import {
  contratoIdDaRota,
  erroContratoPublico,
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
    const data = await gerarResumoContratoPublico({ contratoId, provaToken: body.provaToken, acessoToken: body.acessoToken });
    return new NextResponse(new Uint8Array(data.pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="resumo-contratacao-kidmais-v${data.versao.numeroVersao}.pdf"`,
        "Cache-Control": "no-store",
        "X-Resumo-Pdf-Sha256": data.pdfHash,
        "X-Resumo-Template-Versao": String(data.templateVersao),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { ok: false, erro: "Prova ou Contrato inválidos.", codigo: "DADOS_INVALIDOS" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    return erroContratoPublico(error);
  }
}
