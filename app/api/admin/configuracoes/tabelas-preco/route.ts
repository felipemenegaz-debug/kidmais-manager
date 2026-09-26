import { NextRequest } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/autenticacao/service";
import { simularPrecoPacote, simularTabelaPublicada, criarTabelaPrecoAdmin, incluirPrecoPacoteAdmin, publicarTabelaPrecoAdmin } from "@/lib/comercial/tabelas-preco-admin";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuid = z.string().uuid();
const simular = z.object({ acao: z.literal("simular"), valor: z.string().nullable(), sobConsulta: z.boolean() }).strict();
const simularFesta = z.object({
  acao: z.literal("simular_festa"),
  empresaId: uuid,
  data: z.string().date(),
  pacoteId: uuid,
  convidados: z.number().int().positive(),
  categoriaHorario: z.enum(["PADRAO", "NOBRE", "GERAL"]),
  sobConsulta: z.boolean(),
}).strict();
const criar = z.object({
  acao: z.literal("criar"),
  empresaId: uuid,
  codigo: z.string().trim().min(2).max(50).regex(/^[A-Z][A-Z0-9_]+$/),
  nome: z.string().trim().min(1).max(160),
  vigenciaInicio: z.string().date(),
  vigenciaFim: z.string().date().nullable(),
}).strict();
const preco = z.object({
  acao: z.literal("preco"),
  empresaId: uuid,
  tabelaId: uuid,
  pacoteId: uuid,
  convidadosMin: z.number().int().positive(),
  convidadosMax: z.number().int().positive().nullable(),
  tipoCalculo: z.enum(["FIXO", "POR_CONVIDADO"]),
  valor: z.string(),
  categoriaHorario: z.enum(["PADRAO", "NOBRE", "GERAL"]),
}).strict();
const publicar = z.object({ acao: z.literal("publicar"), empresaId: uuid, tabelaId: uuid }).strict();
const corpo = z.discriminatedUnion("acao", [simular, simularFesta, criar, preco, publicar]);

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    if (sessao.papel !== "REPRESENTANTE_AUTORIZADO") throw authError("Apenas o proprietário pode editar tabelas de preços.", 403);
    const bruto = await request.json();
    if (z.object({ acao: z.literal("simular") }).passthrough().safeParse(bruto).success && bruto.acao === "simular") {
      return jsonNoStore({ ok: true, data: simularPrecoPacote(simular.parse(bruto)) });
    }
    const pedido = z.object({ empresaId: z.string().optional() }).passthrough().parse(bruto);
    const data = await withTenantTransaction(sessao, pedido.empresaId, async (tx, tenant) => {
      const input = corpo.parse(bruto);
      const empresaId = tenant.empresaComprovada;
      const ator = { usuarioId: sessao.usuario_id, requestId: crypto.randomUUID(), motivo: null };
      if (input.acao === "simular_festa") return simularTabelaPublicada(tx, { ...input, empresaId });
      if (input.acao === "criar") return criarTabelaPrecoAdmin(tx, { ...input, empresaId }, ator);
      if (input.acao === "preco") {
        await incluirPrecoPacoteAdmin(tx, { ...input, empresaId, usuarioId: ator.usuarioId, requestId: ator.requestId });
        return input.tabelaId;
      }
      if (input.acao === "publicar") {
        await publicarTabelaPrecoAdmin(tx, { empresaId, tabelaId: input.tabelaId, usuarioId: ator.usuarioId, requestId: ator.requestId });
        return input.tabelaId;
      }
      return simularPrecoPacote(input);
    });
    return jsonNoStore({ ok: true, data }, { status: bruto.acao === "criar" ? 201 : 200 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
