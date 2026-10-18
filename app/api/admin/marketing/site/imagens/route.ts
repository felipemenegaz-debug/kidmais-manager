import type { NextRequest } from "next/server";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirRecursoPlano } from "@/lib/assinatura/recursos-plano";
import { exigirCapacidadeMarketing } from "@/lib/marketing/capacidades";
import { MarketingError } from "@/lib/marketing/erros";
import { parametroUuid } from "@/lib/marketing/http";
import { IMAGEM_MAX_UPLOAD, IMAGEM_TIPOS, listarImagens, normalizarImagemSite, salvarImagem } from "@/lib/marketing/site/imagens";
import { siteDaEmpresa } from "@/lib/marketing/site/servico";
import type { DbExecutor } from "@/lib/db/contracts";
import type { TenantComprovado } from "@/lib/saas/provar-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lê o corpo com teto (vale também sem Content-Length) antes de analisar o multipart. */
async function lerFormulario(request: NextRequest) {
  const reader = request.body?.getReader();
  if (!reader) throw new MarketingError("MARKETING_IMAGEM_INVALIDA", "Selecione uma imagem.", 400);
  const partes: Uint8Array[] = [];
  let tamanho = 0;
  try {
    while (true) {
      const parte = await reader.read();
      if (parte.done) break;
      tamanho += parte.value.length;
      if (tamanho > IMAGEM_MAX_UPLOAD + 65_536) throw new MarketingError("MARKETING_IMAGEM_INVALIDA", "Envie uma imagem de até 8 MB.", 413);
      partes.push(parte.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  try {
    return await new Request(request.url, { method: "POST", headers: request.headers, body: new Uint8Array(Buffer.concat(partes)) }).formData();
  } catch { throw new MarketingError("MARKETING_IMAGEM_INVALIDA", "Envie uma imagem PNG, JPEG ou WebP.", 400); }
}

async function autorizar(tx: DbExecutor, tenant: TenantComprovado, siteId: string) {
  await exigirRecursoPlano(tx, tenant.empresaComprovada, "MARKETING");
  await exigirCapacidadeMarketing(tx, tenant, "MARKETING_SITE_EDITAR");
  await siteDaEmpresa(tx, tenant.empresaComprovada, siteId);
}

/**
 * Envio de imagem para o site (fica PRIVADA até a publicação de uma versão que a cite). Ordem: guarda administrativa
 * → leitura limitada do corpo → autorização no tenant → reprocessamento (fora de transação) → gravação no tenant, que
 * repete a autorização (revogação no meio do envio impede a gravação).
 */
export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const form = await lerFormulario(request);
    const enviado = form.get("arquivo");
    const siteId = parametroUuid(String(form.get("siteId") ?? ""));
    if (!siteId || !(enviado instanceof File) || form.getAll("arquivo").length !== 1 || !IMAGEM_TIPOS.includes(enviado.type)) {
      throw new MarketingError("MARKETING_IMAGEM_INVALIDA", "Envie uma imagem PNG, JPEG ou WebP.", 400);
    }
    const descricao = String(form.get("descricao") ?? "").trim().slice(0, 140) || null;
    await withTenantTransaction(sessao, null, (tx, tenant) => autorizar(tx, tenant, siteId));
    const imagem = await normalizarImagemSite(Buffer.from(await enviado.arrayBuffer()));
    const data = await withTenantTransaction(sessao, null, async (tx, tenant) => {
      await autorizar(tx, tenant, siteId);
      const salva = await salvarImagem(tx, tenant.empresaComprovada, siteId, tenant.usuarioId, imagem, descricao);
      return { imagem: salva, imagens: await listarImagens(tx, tenant.empresaComprovada, siteId) };
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
