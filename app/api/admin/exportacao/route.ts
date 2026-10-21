import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { contextoDaRequisicao } from "@/lib/acessos/http";
import { hojeIso } from "@/lib/financeiro/http";
import { withTransaction } from "@/lib/db/postgres";
import { PacoteAdminError } from "@/lib/comercial/pacotes-admin";
import { exportarDados, TIPOS_EXPORTACAO } from "@/lib/assinatura/exportacao";
import { provarTenantParaExportacao, revalidarTenantExportacao } from "@/lib/exportacao/guarda";
import { exportarPacoteCompleto } from "@/lib/exportacao/servico";
import { VERSAO_FORMATO } from "@/lib/exportacao/pacote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PEDIDO_COMPLETO = z.object({ tipo: z.literal("completa"), empresaId: z.string().trim().max(64).nullish() }).strict();

/** Navegação vinda de outro site (Sec-Fetch-Site cross-site/same-site) não baixa dados; sem o cabeçalho (cliente
 * que não é navegador) ou digitado/aberto pela própria pessoa (none) ou da mesma origem, segue. */
function exigirMesmaOrigem(request: NextRequest) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none")
    throw new PacoteAdminError("ORIGEM_RECUSADA", "Abra a exportação pela tela do Kidmais Manager.", 403);
}

/**
 * Pacote completo verificável (lib/exportacao): POST com a proteção CSRF padrão do Admin (origem + x-csrf-token, em
 * exigirApiAdminCrmDisponivel). Só Gestão, auditado; sempre permitido pelo paywall. A guarda aceita também a empresa
 * SUSPENSA pedida explicitamente por `empresaId`, mesmo com a sessão numa empresa ativa (exceção mínima, só aqui).
 * O ZIP já está pronto em disco temporário e auditado quando a resposta começa; vai por fluxo e a pasta é apagada ao
 * terminar, falhar ou ser abandonado.
 */
export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const pedido = PEDIDO_COMPLETO.parse(await request.json());
    const ctx = contextoDaRequisicao(request);
    const r = await exportarPacoteCompleto(sessao, pedido.empresaId ?? null, { requestId: ctx.requestId }, undefined, { permitirSelecaoNoutraEmpresa: true });
    const arquivo = createReadStream(r.zipCaminho);
    arquivo.once("close", () => { void r.limpar(); });
    arquivo.once("error", () => { void r.limpar(); });
    return new Response(Readable.toWeb(arquivo) as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${r.nomeArquivo}"`,
        "Content-Length": String(r.zipBytes),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Kidmais-Exportacao-Formato": String(VERSAO_FORMATO),
        "X-Kidmais-Manifesto-Sha256": r.manifestoSha256,
        "X-Kidmais-Pacote-Sha256": r.zipSha256,
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** CSVs avulsos de antes (clientes, contas a receber), pela mesma guarda (regra estrita de sessão). */
export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    exigirMesmaOrigem(request);
    const bruto = request.nextUrl.searchParams.get("tipo");
    if (bruto === "completa") throw new PacoteAdminError("METODO_NAO_PERMITIDO", "Gere o pacote completo pelo botão da tela.", 405);
    const tipo = z.enum(TIPOS_EXPORTACAO).parse(bruto);
    const empresaId = request.nextUrl.searchParams.get("empresaId");
    const ctx = contextoDaRequisicao(request);
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
