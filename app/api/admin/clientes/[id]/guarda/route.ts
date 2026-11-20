import { NextRequest } from "next/server";
import { z } from "zod";
import { lerMarcosDoCliente } from "@/lib/guarda/marcos";
import { saidasDoCliente } from "@/lib/guarda/saidas-contato";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Guarda dos dados do cliente (fase 1, 19/11/2026), SÓ LEITURA: datas-base dos prazos do DPA e marcas de saída das
 * campanhas por telefone/e-mail. Nada é apagado nem alterado aqui (G3).
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const id = z.string().uuid().safeParse((await Promise.resolve(context.params)).id);
    if (!id.success) return jsonNoStore({ ok: false, erro: "ID de Cliente inválido.", codigo: "DADOS_INVALIDOS" }, { status: 400 });
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), async (tx, tenant) => {
      const marcos = await lerMarcosDoCliente(tx, tenant.empresaComprovada, id.data);
      if (!marcos) return null;
      return { marcos, saidas: await saidasDoCliente(tx, tenant.empresaComprovada, marcos.clienteId) };
    });
    if (!data) return jsonNoStore({ ok: false, erro: "Cliente não encontrado.", codigo: "NAO_ENCONTRADO" }, { status: 404 });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
