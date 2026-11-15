import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  AreaFamiliaError, cadastrarSegundo, configurarPendenciaFamilia, desconectarTodos, devolverPendenciaFamilia, gerarLinkArea, removerSegundo,
  resumoAreaFamilia, salvarAvisoFixo, tratarAvisoPagamento,
} from "@/lib/area-familia/admin";
import { areaFamiliaLigada, pepperIdentidade } from "@/lib/area-familia/http";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { exigirGestaoNoTenant, withTenantTransaction } from "@/lib/saas/provar-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const acao = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("GERAR_LINK"), papel: z.enum(["CONTRATANTE", "SEGUNDO_RESPONSAVEL"]) }).strict(),
  z.object({ acao: z.literal("DESCONECTAR_TODOS") }).strict(),
  z.object({
    acao: z.literal("CADASTRAR_SEGUNDO"),
    nome: z.string().trim().min(2).max(120),
    whatsapp: z.string().trim().min(10).max(20),
    email: z.string().trim().email().max(254).optional().nullable(),
    documento: z.string().trim().max(20).optional().nullable(),
  }).strict(),
  z.object({ acao: z.literal("REMOVER_SEGUNDO"), pessoaId: z.string().uuid() }).strict(),
  // F3 (125)
  z.object({ acao: z.literal("TRATAR_AVISO_PAGAMENTO"), avisoId: z.string().uuid(), decisao: z.enum(["CONFERIDO", "DESCARTADO"]) }).strict(),
  z.object({ acao: z.literal("PENDENCIA_FAMILIA"), pendenciaId: z.string().uuid(), visivel: z.boolean(), texto: z.string().max(280) }).strict(),
  z.object({ acao: z.literal("DEVOLVER_PENDENCIA"), pendenciaId: z.string().uuid() }).strict(),
  z.object({ acao: z.literal("AVISO_FIXO"), texto: z.string().max(500).nullable() }).strict(),
]);

function erro(error: unknown) {
  if (error instanceof AreaFamiliaError) return jsonNoStore({ ok: false, erro: error.message, codigo: error.code }, { status: error.httpStatus });
  return apiErrorResponse(error);
}

const desligada = () => jsonNoStore({ ok: false, erro: "Recurso indisponível.", codigo: "AREA_FAMILIA_DESLIGADA" }, { status: 404 });

/** Painel: pessoas, validade dos links e aparelhos conectados (sem token, CPF nem telefone completo). Só Gestão (AF-R3). */
export async function GET(request: NextRequest, contexto: { params: Promise<{ festaId: string }> }) {
  if (!areaFamiliaLigada()) return desligada();
  try {
    const { festaId } = await contexto.params;
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), (tx, tenant) => {
      exigirGestaoNoTenant(tenant, "Só a gestão do buffet vê o acesso da família.");
      return resumoAreaFamilia(tx, { empresaId: tenant.empresaComprovada, usuarioId: tenant.usuarioId }, festaId);
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return erro(error);
  }
}

/** Ações do buffet: só Gestão da empresa. O link volta uma única vez (o banco guarda só o hash). */
export async function POST(request: NextRequest, contexto: { params: Promise<{ festaId: string }> }) {
  if (!areaFamiliaLigada()) return desligada();
  try {
    const { festaId } = await contexto.params;
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const input = acao.parse(await request.json());
    const pepper = pepperIdentidade();
    if (!pepper) return jsonNoStore({ ok: false, erro: "Indisponível agora.", codigo: "CONFIGURACAO_INDISPONIVEL" }, { status: 503 });
    const data = await withTenantTransaction(sessao, null, async (tx, tenant) => {
      exigirGestaoNoTenant(tenant, "Só a gestão do buffet gerencia o acesso da família.");
      const ctx = { empresaId: tenant.empresaComprovada, usuarioId: tenant.usuarioId };
      switch (input.acao) {
        case "GERAR_LINK": return gerarLinkArea(tx, ctx, festaId, input.papel);
        case "DESCONECTAR_TODOS": return desconectarTodos(tx, ctx, festaId);
        case "CADASTRAR_SEGUNDO": return cadastrarSegundo(tx, ctx, festaId, input, pepper);
        case "REMOVER_SEGUNDO": return removerSegundo(tx, ctx, festaId, input.pessoaId);
        case "TRATAR_AVISO_PAGAMENTO": return tratarAvisoPagamento(tx, ctx, festaId, input.avisoId, input.decisao);
        case "PENDENCIA_FAMILIA": return configurarPendenciaFamilia(tx, ctx, festaId, input.pendenciaId, input);
        case "DEVOLVER_PENDENCIA": return devolverPendenciaFamilia(tx, ctx, festaId, input.pendenciaId);
        case "AVISO_FIXO": return salvarAvisoFixo(tx, ctx, festaId, input.texto);
      }
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return erro(error);
  }
}
