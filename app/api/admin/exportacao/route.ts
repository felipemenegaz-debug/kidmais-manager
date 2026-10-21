import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { contextoDaRequisicao } from "@/lib/acessos/http";
import { hojeIso } from "@/lib/financeiro/http";
import { withTransaction } from "@/lib/db/postgres";
import { exportarDados, TIPOS_EXPORTACAO } from "@/lib/assinatura/exportacao";
import { provarTenantParaExportacao, revalidarTenantExportacao } from "@/lib/exportacao/guarda";
import { exportarPacoteCompleto } from "@/lib/exportacao/servico";
import { VERSAO_FORMATO } from "@/lib/exportacao/pacote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIPOS = ["completa", ...TIPOS_EXPORTACAO] as const;

/**
 * Exportação dos dados da própria empresa (só Gestão, auditada). Sempre permitida pelo paywall: o vencimento não prende
 * os dados. `tipo=completa` entrega o pacote ZIP verificável (lib/exportacao); `clientes` e `contas-receber`, os CSVs
 * avulsos de antes. Todas passam pela guarda da exportação, que aceita também a empresa SUSPENSA pedida explicitamente
 * por `empresaId` (exceção mínima, só para exportar; lib/exportacao/guarda.ts).
 */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const tipo = z.enum(TIPOS).parse(request.nextUrl.searchParams.get("tipo"));
    const empresaId = request.nextUrl.searchParams.get("empresaId");
    const ctx = contextoDaRequisicao(request);
    if (tipo === "completa") {
      const r = await exportarPacoteCompleto(sessao, empresaId, { requestId: ctx.requestId });
      return new Response(new Uint8Array(r.zip), {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${r.nomeArquivo}"`,
          "Content-Length": String(r.zip.length),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Kidmais-Exportacao-Formato": String(VERSAO_FORMATO),
          "X-Kidmais-Manifesto-Sha256": r.manifestoSha256,
          "X-Kidmais-Pacote-Sha256": r.zipSha256,
        },
      });
    }
    const r = await withTransaction(async (tx) => {
      const tenant = await provarTenantParaExportacao(tx, sessao, empresaId);
      const resultado = await exportarDados(tx, tenant, tipo, ctx, hojeIso());
      await revalidarTenantExportacao(tx, tenant);
      return resultado;
    });
    return new NextResponse(r.conteudo, {
      status: 200,
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${r.arquivo}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
