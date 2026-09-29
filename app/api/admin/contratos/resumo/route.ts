import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  adquirirResumoContratoAdmin,
  isContratoServiceError,
  renderizarResumoContratoAdmin,
} from "@/lib/contratos/services";
import { isClienteServiceError } from "@/lib/clientes/services";
import { PacoteAdminError } from "@/lib/comercial/pacotes-admin";
import { exportarContratoDoTenant } from "@/lib/contratos/services/exportacao-tenant";
import { ResumoTenantError } from "@/lib/contratos/services/resumo-tenant";
import { apiErrorResponse } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const parsed = z.string().uuid().safeParse(
      request.nextUrl.searchParams.get("fechamentoId") ?? "",
    );
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, erro: "Informe um fechamentoId válido.", codigo: "DADOS_INVALIDOS" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    // D1: prova de tenant e TODAS as consultas na mesma transação; o PDF é montado depois do commit, só em
    // memória. Fechamento de outra empresa, legado ou inexistente ⇒ 404 igual.
    const data = await exportarContratoDoTenant(sessao, request.nextUrl.searchParams.get("empresaId"), parsed.data, {
      withTenantTransaction,
      adquirir: adquirirResumoContratoAdmin,
      renderizar: renderizarResumoContratoAdmin,
    });
    return new NextResponse(new Uint8Array(data.pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="resumo-contratacao-${data.contrato.id}-v${data.versao.numeroVersao}.pdf"`,
        "Cache-Control": "no-store",
        "X-Resumo-Pdf-Sha256": data.pdfHash,
        "X-Resumo-Template-Versao": String(data.templateVersao),
      },
    });
  } catch (error) {
    if (error instanceof ResumoTenantError) {
      return NextResponse.json({ ok: false, erro: error.message, codigo: error.code }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    if (error instanceof PacoteAdminError) return apiErrorResponse(error);
    if (isContratoServiceError(error) || isClienteServiceError(error)) {
      return NextResponse.json(
        { ok: false, erro: error.message, codigo: error.code, detalhes: error.details ?? null },
        { status: error.httpStatus, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error("[Kidmais Resumo Contratação PDF Admin] erro não tratado", error);
    return NextResponse.json(
      { ok: false, erro: "Não foi possível gerar o Resumo da Contratação.", codigo: "ERRO_PDF_RESUMO" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
