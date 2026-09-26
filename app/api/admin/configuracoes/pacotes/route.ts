import { NextRequest } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/autenticacao/service";
import { registrarAuditoria } from "@/lib/clientes/repositories/auditoria.repository";
import { criarPacoteAdmin, duplicarPacoteAdmin, listarPacotesAdmin } from "@/lib/comercial/pacotes-admin";
import { withTransaction } from "@/lib/db/postgres";
import type { DbExecutor } from "@/lib/db/contracts";
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
  codigo,
  nome,
  descricao: texto,
  duracaoMinutos: duracao,
  motivo: z.string().trim().min(3).max(500),
}).strict();
const duplicar = z.object({
  acao: z.literal("duplicar"),
  empresaId: uuid,
  origemId: uuid,
  codigo,
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

function auditar(usuarioId: string, requestId: string) {
  return (tx: DbExecutor, evento: { usuarioId: string; requestId: string; acao: string; pacoteId: string; antes: unknown; depois: unknown; motivo: string }) =>
    registrarAuditoria({
      atorTipo: "USUARIO",
      usuarioId,
      acao: evento.acao,
      entidadeTipo: "PACOTE",
      entidadeId: evento.pacoteId,
      origem: "CRM_INTERNO",
      requestId,
      dadosAntes: evento.antes as Record<string, unknown> | null,
      dadosDepois: evento.depois as Record<string, unknown> | null,
      justificativa: evento.motivo,
    }, tx);
}

export async function GET(request: NextRequest) {
  try {
    await exigirApiAdminCrmDisponivel(request);
    const empresaId = uuid.safeParse(request.nextUrl.searchParams.get("empresaId"));
    if (!empresaId.success) return jsonNoStore({ ok: false, erro: "Empresa inválida.", codigo: "DADOS_INVALIDOS" }, { status: 400 });
    const data = await withTransaction((tx) => listarPacotesAdmin(tx, empresaId.data));
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirEscrita(request);
    const input = corpo.parse(await request.json());
    const ctx = { empresaId: input.empresaId, usuarioId: sessao.usuario_id, requestId: crypto.randomUUID(), motivo: input.motivo };
    const data = await withTransaction((tx) => input.acao === "criar"
      ? criarPacoteAdmin(tx, input, ctx, auditar(sessao.usuario_id, ctx.requestId))
      : duplicarPacoteAdmin(tx, input.origemId, input.codigo, ctx, auditar(sessao.usuario_id, ctx.requestId)));
    return jsonNoStore({ ok: true, data }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
