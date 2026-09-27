import { NextRequest } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/autenticacao/service";
import { criarPacoteAdmin, duplicarPacoteAdmin, listarPacotesAdmin } from "@/lib/comercial/pacotes-admin";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuid = z.string().uuid();
const codigo = z.string().trim().min(2).max(50).regex(/^[A-Z][A-Z0-9_]+$/);
const nome = z.string().trim().min(1).max(160);
const texto = z.string().trim().max(2000).nullable();
const duracao = z.number().int().positive().max(1440).nullable();
const criar = z.object({
  acao: z.literal("criar"),
  empresaId: uuid,
  codigo: codigo.optional(),
  nome,
  descricao: texto,
  duracaoMinutos: duracao,
  motivo: z.string().trim().min(3).max(500).optional(),
}).strict();
const duplicar = z.object({
  acao: z.literal("duplicar"),
  empresaId: uuid,
  origemId: uuid,
  codigo: codigo.optional(),
  motivo: z.string().trim().min(3).max(500),
}).strict();
const corpo = z.discriminatedUnion("acao", [criar, duplicar]);

async function exigirEscrita(request: NextRequest) {
  const sessao = await exigirApiAdminCrmDisponivel(request);
  if (sessao.papel !== "REPRESENTANTE_AUTORIZADO") {
    throw authError("Apenas o proprietário pode editar pacotes.", 403);
  }
  return sessao;
}

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await withTenantTransaction(
      sessao,
      request.nextUrl.searchParams.get("empresaId"),
      (tx, tenant) => listarPacotesAdmin(tx, tenant.empresaComprovada),
    );
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirEscrita(request);
    const bruto = await request.json();
    const pedido = z.object({ empresaId: z.string().optional() }).passthrough().parse(bruto);
    const data = await withTenantTransaction(sessao, pedido.empresaId, async (tx, tenant) => {
      const input = corpo.parse({ ...bruto, empresaId: tenant.empresaComprovada });
      const ctx = {
        empresaId: tenant.empresaComprovada,
        usuarioId: sessao.usuario_id,
        requestId: crypto.randomUUID(),
        motivo: input.motivo,
      };
      if (input.acao === "criar") {
        return criarPacoteAdmin(tx, { ...input, empresaId: tenant.empresaComprovada }, ctx);
      }
      return duplicarPacoteAdmin(tx, input.origemId, input.codigo, ctx);
    });
    return jsonNoStore({ ok: true, data }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
