import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import type { EmTransacao } from "@/lib/comercial/adicionais-admin";
import { revisaoSchema } from "@/lib/comercial/importacao-tabela/revisao-schema";
import { descartarImportacao, lerImportacao, publicarImportacao, salvarRevisao } from "@/lib/comercial/importacao-tabela/servico";
import { PacoteAdminError } from "@/lib/comercial/pacotes-admin";
import { exigirGestaoNoTenant, withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Contexto = { params: Promise<{ id: string }> };

const acao = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("publicar"), versao: z.number().int().min(1), empresaId: z.string().uuid().nullable().optional() }).strict(),
  z.object({ acao: z.literal("descartar"), empresaId: z.string().uuid().nullable().optional() }).strict(),
]);
const edicao = z.object({ versao: z.number().int().min(1), revisao: revisaoSchema, empresaId: z.string().uuid().nullable().optional() }).strict();

export async function GET(request: NextRequest, contexto: Contexto) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const id = z.string().uuid().parse((await contexto.params).id);
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), (tx, tenant) =>
      lerImportacao(tx, tenant.empresaComprovada, id));
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest, contexto: Contexto) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const id = z.string().uuid().parse((await contexto.params).id);
    const dados = edicao.parse(await request.json());
    const data = await withTenantTransaction(sessao, dados.empresaId ?? null, (tx, tenant) => {
      exigirGestaoNoTenant(tenant, "Apenas o proprietário pode revisar a importação.");
      return salvarRevisao(tx, { empresaId: tenant.empresaComprovada, usuarioId: sessao.usuario_id, requestId: randomUUID() }, id, dados.versao, dados.revisao);
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest, contexto: Contexto) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const id = z.string().uuid().parse((await contexto.params).id);
    const pedido = acao.parse(await request.json());
    const empresaSolicitada = pedido.empresaId ?? null;
    let empresa: string | null = null;
    const emTransacao: EmTransacao = (trabalho) => withTenantTransaction(sessao, empresaSolicitada, async (tx, tenant) => {
      exigirGestaoNoTenant(tenant, "Apenas o proprietário pode publicar a importação.");
      if (empresa !== null && tenant.empresaComprovada !== empresa) throw new PacoteAdminError("EMPRESA_ALTERADA", "A empresa ativa mudou durante a operação.", 409);
      empresa = tenant.empresaComprovada;
      return trabalho(tx);
    });
    const empresaId = await emTransacao(async () => empresa!);
    const ctx = { empresaId, usuarioId: sessao.usuario_id, requestId: randomUUID() };
    if (pedido.acao === "descartar") {
      await emTransacao((tx) => descartarImportacao(tx, ctx, id));
      return jsonNoStore({ ok: true });
    }
    const data = await publicarImportacao(emTransacao, ctx, id, pedido.versao);
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
