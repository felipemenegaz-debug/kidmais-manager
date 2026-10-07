import { NextRequest, NextResponse } from "next/server";
import { adicionaisDoPacoteNoTenant } from "@/lib/comercial/adicionais-tenant";
import { PACOTE_CODIGO_BANCO, idDoAdicionalNaTela } from "@/lib/fechamentos/comercial-input";
import { apiErrorResponse } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/**
 * Adicionais do fechamento administrativo com Tenant Context: sessão → provarTenant → pacote, tabela de
 * preços e adicionais DA empresa comprovada. Somente leitura. Substitui, no admin, a rota pública que
 * está fechada desde a PR-A (catálogo público sem empresa comprovada).
 */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const parametros = request.nextUrl.searchParams;
    const pacoteCodigo = PACOTE_CODIGO_BANCO[(parametros.get("pacote") ?? "") as keyof typeof PACOTE_CODIGO_BANCO];
    if (!pacoteCodigo) return NextResponse.json({ ok: false, erro: "Informe pacote, data e convidados válidos.", codigo: "DADOS_INVALIDOS" }, { status: 400, headers: noStore });
    const adicionais = await withTenantTransaction(sessao, parametros.get("empresaId"), (tx, tenant) => adicionaisDoPacoteNoTenant(tx, {
      empresaId: tenant.empresaComprovada,
      pacoteCodigo,
      data: parametros.get("data") ?? "",
      convidados: Number(parametros.get("convidados")),
    }));
    return NextResponse.json({
      adicionais: adicionais.map((a) => ({ id: idDoAdicionalNaTela(a.codigo), ...a })),
    }, { headers: noStore });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
