import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import { conteudoModeloSchema, problemasDoConteudo } from "@/lib/contratos/modelo-empresa/conteudo";
import {
  descartarImportacaoContrato, lerImportacaoContrato, previaModeloContrato, publicarModeloContrato, salvarRevisaoContrato,
} from "@/lib/contratos/modelo-empresa/servico";
import { exigirGestaoNoTenant, withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Contexto = { params: Promise<{ id: string }> };
const empresaId = z.string().uuid().nullable().optional();
const revisao = z.object({ conteudo: conteudoModeloSchema, avisos: z.array(z.string().max(400)).max(40) }).strict();
const acao = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("publicar"), versao: z.number().int().min(1), revisadoPorPessoa: z.literal(true), empresaId }).strict(),
  z.object({ acao: z.literal("descartar"), empresaId }).strict(),
  z.object({ acao: z.literal("previa"), conteudo: conteudoModeloSchema, empresaId }).strict(),
]);

export async function GET(request: NextRequest, contexto: Contexto) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const id = z.string().uuid().parse((await contexto.params).id);
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), (tx, tenant) =>
      lerImportacaoContrato(tx, tenant.empresaComprovada, id));
    return jsonNoStore({ ok: true, data: { ...data, problemas: data.revisao ? problemasDoConteudo(data.revisao.conteudo) : [] } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest, contexto: Contexto) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const id = z.string().uuid().parse((await contexto.params).id);
    const dados = z.object({ versao: z.number().int().min(1), revisao, empresaId }).strict().parse(await request.json());
    const data = await withTenantTransaction(sessao, dados.empresaId ?? null, (tx, tenant) => {
      exigirGestaoNoTenant(tenant, "Apenas o proprietário pode revisar o modelo de contrato.");
      return salvarRevisaoContrato(tx, { empresaId: tenant.empresaComprovada, usuarioId: sessao.usuario_id, requestId: randomUUID() }, id, dados.versao, dados.revisao);
    });
    return jsonNoStore({ ok: true, data: { ...data, problemas: data.revisao ? problemasDoConteudo(data.revisao.conteudo) : [] } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest, contexto: Contexto) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const id = z.string().uuid().parse((await contexto.params).id);
    const pedido = acao.parse(await request.json());
    if (pedido.acao === "previa") {
      // Só a sessão e a empresa: a prévia usa dados fictícios e não lê nem grava nada da empresa.
      await withTenantTransaction(sessao, pedido.empresaId ?? null, async () => undefined);
      const pdf = previaModeloContrato(pedido.conteudo);
      return new Response(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="previa-contrato-${id.slice(0, 8)}.pdf"`, "Cache-Control": "no-store" } });
    }
    const data = await withTenantTransaction(sessao, pedido.empresaId ?? null, async (tx, tenant) => {
      exigirGestaoNoTenant(tenant, "Apenas o proprietário pode publicar o modelo de contrato.");
      const ctx = { empresaId: tenant.empresaComprovada, usuarioId: sessao.usuario_id, requestId: randomUUID() };
      if (pedido.acao === "descartar") { await descartarImportacaoContrato(tx, ctx, id); return { descartado: true }; }
      return publicarModeloContrato(tx, ctx, id, pedido.versao, { revisadoPorPessoa: true });
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
