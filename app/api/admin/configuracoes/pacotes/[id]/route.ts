import { NextRequest } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/autenticacao/service";
import { registrarAuditoria } from "@/lib/clientes/repositories/auditoria.repository";
import { alterarSituacaoPacoteAdmin, consultarPacoteAdmin, criarRevisaoPacoteAdmin, editarPacoteNaoUtilizado } from "@/lib/comercial/pacotes-admin";
import type { DbExecutor } from "@/lib/db/contracts";
import { withTransaction } from "@/lib/db/postgres";
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

function auditar(usuarioId: string, requestId: string) {
  return (tx: DbExecutor, evento: { acao: string; pacoteId: string; antes: unknown; depois: unknown; motivo: string }) =>
    registrarAuditoria({
      atorTipo: "USUARIO", usuarioId, acao: evento.acao, entidadeTipo: "PACOTE", entidadeId: evento.pacoteId,
      origem: "CRM_INTERNO", requestId, dadosAntes: evento.antes as Record<string, unknown> | null, dadosDepois: evento.depois as Record<string, unknown> | null, justificativa: evento.motivo,
    }, tx);
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const id = uuid.safeParse((await context.params).id);
    const empresaId = uuid.safeParse(request.nextUrl.searchParams.get("empresaId"));
    if (!id.success || !empresaId.success) return jsonNoStore({ ok: false, erro: "Pacote ou empresa inválidos.", codigo: "DADOS_INVALIDOS" }, { status: 400 });
    const data = await withTransaction((tx) => consultarPacoteAdmin(tx, empresaId.data, id.data));
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
    const input = corpo.parse(await request.json());
    const requestId = crypto.randomUUID();
    const ctx = { empresaId: input.empresaId, usuarioId: sessao.usuario_id, requestId, motivo: input.motivo };
    const data = await withTransaction((tx) => {
      const registrar = auditar(sessao.usuario_id, requestId);
      if (input.acao === "editar") return editarPacoteNaoUtilizado(tx, id.data, input, ctx, registrar);
      if (input.acao === "revisar") return criarRevisaoPacoteAdmin(tx, id.data, input, ctx, registrar);
      return alterarSituacaoPacoteAdmin(tx, id.data, input.acao, ctx, registrar);
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
