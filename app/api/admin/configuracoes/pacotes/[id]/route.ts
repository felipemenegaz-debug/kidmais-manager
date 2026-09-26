import { NextRequest } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/autenticacao/service";
import { alterarSituacaoPacoteAdmin, consultarPacoteAdmin, criarRevisaoPacoteAdmin, editarPacoteNaoUtilizado } from "@/lib/comercial/pacotes-admin";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuid = z.string().uuid();
const nome = z.string().trim().min(1).max(160);
const texto = z.string().trim().max(2000).nullable();
const duracao = z.number().int().positive().max(1440).nullable();
const motivo = z.string().trim().min(3).max(500);
const editar = z.object({ acao: z.literal("editar"), empresaId: uuid, nome, descricao: texto, duracaoMinutos: duracao, motivo }).strict();
const revisar = z.object({ acao: z.literal("revisar"), empresaId: uuid, nome, descricao: texto, duracaoMinutos: duracao, motivo }).strict();
const situacao = z.object({ acao: z.enum(["ativar", "desativar", "arquivar"]), empresaId: uuid, motivo }).strict();
const corpo = z.discriminatedUnion("acao", [editar, revisar, situacao]);
type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const id = uuid.safeParse((await context.params).id);
    if (!id.success) return jsonNoStore({ ok: false, erro: "Pacote inválido.", codigo: "DADOS_INVALIDOS" }, { status: 400 });
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), async (tx, tenant) => {
      const pacote = await consultarPacoteAdmin(tx, tenant.empresaComprovada, id.data);
      if (!pacote) return null;
      return pacote;
    });
    if (!data) return jsonNoStore({ ok: false, erro: "Pacote não encontrado nesta empresa.", codigo: "NAO_ENCONTRADO" }, { status: 404 });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    if (sessao.papel !== "REPRESENTANTE_AUTORIZADO") throw authError("Apenas o proprietário pode editar pacotes.", 403);
    const id = uuid.safeParse((await context.params).id);
    if (!id.success) return jsonNoStore({ ok: false, erro: "Pacote inválido.", codigo: "DADOS_INVALIDOS" }, { status: 400 });
    const bruto = await request.json();
    const pedido = z.object({ empresaId: z.string().optional() }).passthrough().parse(bruto);
    const data = await withTenantTransaction(sessao, pedido.empresaId, async (tx, tenant) => {
      const input = corpo.parse(bruto);
      const ctx = {
        empresaId: tenant.empresaComprovada,
        usuarioId: sessao.usuario_id,
        requestId: crypto.randomUUID(),
        motivo: input.motivo,
      };
      if (input.acao === "editar") return editarPacoteNaoUtilizado(tx, id.data, input, ctx);
      if (input.acao === "revisar") return criarRevisaoPacoteAdmin(tx, id.data, input, ctx);
      return alterarSituacaoPacoteAdmin(tx, id.data, input.acao, ctx);
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
