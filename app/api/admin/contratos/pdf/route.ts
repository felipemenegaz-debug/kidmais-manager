import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  gerarPdfContratoAdmin,
  isContratoServiceError,
} from "@/lib/contratos/services";
import { isClienteServiceError } from "@/lib/clientes/services";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const parsed = z.string().uuid().safeParse(
      request.nextUrl.searchParams.get("fechamentoId") ?? "",
    );
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, erro: "Informe um fechamentoId válido.", codigo: "DADOS_INVALIDOS" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const data = await gerarPdfContratoAdmin(parsed.data);
    return new NextResponse(new Uint8Array(data.pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="contrato-oficial-${data.contrato.id}-v${data.versao.numeroVersao}.pdf"`,
        "Cache-Control": "no-store",
        "X-Contrato-Pdf-Sha256": data.pdfHash,
        "X-Contrato-Template-Versao": String(data.templateVersao),
        "X-Contrato-Modelo": data.modeloCodigo,
      },
    });
  } catch (error) {
    if (isContratoServiceError(error) || isClienteServiceError(error)) {
      return NextResponse.json(
        { ok: false, erro: error.message, codigo: error.code, detalhes: error.details ?? null },
        { status: error.httpStatus, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error("[Kidmais Contratos PDF Admin] erro não tratado", error);
    return NextResponse.json(
      { ok: false, erro: "Não foi possível gerar o PDF.", codigo: "ERRO_PDF_CONTRATO" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
