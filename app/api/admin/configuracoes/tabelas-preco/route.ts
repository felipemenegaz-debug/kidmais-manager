import { NextRequest } from "next/server";
import { z } from "zod";
import { simularPrecoPacote, simularTabelaPublicada, criarTabelaPrecoAdmin, incluirPrecoPacoteAdmin, publicarTabelaPrecoAdmin, substituirEscopoTabelaAdmin, consultarQuadroTabelaAdmin } from "@/lib/comercial/tabelas-preco-admin";
import { exigirGestaoNoTenant, withTenantTransaction } from "@/lib/saas/provar-tenant";
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
const faixa = z.object({
  convidadosMin: z.number().int().positive(),
  convidadosMax: z.number().int().positive().nullable(),
}).strict();
const combinacao = z.object({
  pacoteId: uuid,
  categoriaHorario: z.enum(["GERAL", "PADRAO", "NOBRE"]),
  coberturaContinua: z.boolean(),
  limiteConvidadosMin: z.number().int().positive().nullable(),
  limiteConvidadosMax: z.number().int().positive().nullable(),
  faixas: z.array(faixa).max(40),
}).strict();
const escopo = z.object({
  acao: z.literal("escopo"),
  empresaId: uuid,
  tabelaId: uuid,
  combinacoes: z.array(combinacao).max(80),
}).strict();
const corpo = z.discriminatedUnion("acao", [simular, simularFesta, criar, preco, publicar, escopo]);

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const tabelaId = request.nextUrl.searchParams.get("tabelaId");
    if (tabelaId !== null && !uuid.safeParse(tabelaId).success) {
      return jsonNoStore({ ok: false, erro: "Dados inválidos.", codigo: "DADOS_INVALIDOS" }, { status: 400 });
    }
    const data = await withTenantTransaction(
      sessao,
      request.nextUrl.searchParams.get("empresaId"),
      (tx, tenant) => consultarQuadroTabelaAdmin(tx, tenant.empresaComprovada, tabelaId),
    );
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const bruto = await request.json();
    if (z.object({ acao: z.literal("simular") }).passthrough().safeParse(bruto).success && bruto.acao === "simular") {
      return jsonNoStore({ ok: true, data: simularPrecoPacote(simular.parse(bruto)) });
    }
    const pedido = z.object({ empresaId: z.string().optional() }).passthrough().parse(bruto);
    const data = await withTenantTransaction(sessao, pedido.empresaId, async (tx, tenant) => {
      exigirGestaoNoTenant(tenant, "Apenas o proprietário pode editar tabelas de preços.");
      const input = corpo.parse({ ...bruto, empresaId: tenant.empresaComprovada });
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
      if (input.acao === "escopo") {
        await substituirEscopoTabelaAdmin(tx, { ...input, empresaId, usuarioId: ator.usuarioId, requestId: ator.requestId });
        return input.tabelaId;
      }
      return simularPrecoPacote(input);
    });
    return jsonNoStore({ ok: true, data }, { status: bruto.acao === "criar" ? 201 : 200 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
