import { NextRequest } from "next/server";
import { z } from "zod";
import { registrarAuditoria } from "@/lib/clientes/repositories/auditoria.repository";
import {
  habilitarUnidadeAgenda,
  listarUnidadesAgenda,
  revogarUnidadeAgenda,
  type Auditar,
} from "@/lib/disponibilidade/unidades-agenda";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { contextoCrmDaRequest, exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Habilitação de unidade para agenda (062, D6 = opção A): empresa e papel vêm do Tenant Context; o corpo só escolhe a
// unidade da própria empresa e informa o motivo. O banco confere tudo de novo e guarda o histórico imutável.
const pedido = z.object({
  acao: z.enum(["habilitar", "revogar"]),
  empresaId: z.string().optional(),
  unidadeId: z.string().uuid(),
  motivo: z.string(),
}).strict();

const auditar: Auditar = (tx, registro) => registrarAuditoria(registro, tx);

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const unidades = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"),
      (tx, tenant) => listarUnidadesAgenda(tx, tenant.empresaComprovada));
    return jsonNoStore({ ok: true, unidades });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const dados = pedido.parse(await request.json());
    const contexto = contextoCrmDaRequest(request);
    const ctx = { requestId: contexto.requestId ?? null, ip: null, userAgent: contexto.userAgent ?? null };
    const data = await withTenantTransaction(sessao, dados.empresaId, (tx, tenant): Promise<unknown> =>
      dados.acao === "habilitar"
        ? habilitarUnidadeAgenda(tx, tenant, dados.unidadeId, dados.motivo, ctx, auditar)
        : revogarUnidadeAgenda(tx, tenant, dados.unidadeId, dados.motivo, ctx, auditar));
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
