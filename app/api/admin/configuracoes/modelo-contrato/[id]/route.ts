import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import { problemasDoConteudo } from "@/lib/contratos/modelo-empresa/conteudo";
import { acaoModeloSchema, corpoPatchModeloSchema } from "@/lib/contratos/modelo-empresa/rota-schemas";
import { contratadaEfetiva, aplicarContratada, conferidaDe } from "@/lib/contratos/modelo-empresa/contratada";
import {
  ModeloContratoError, descartarImportacaoContrato, lerImportacaoContrato, previaModeloContrato, publicarModeloContrato, salvarRevisaoContrato,
} from "@/lib/contratos/modelo-empresa/servico";
import { exigirGestaoNoTenant, withTenantTransaction, type TenantComprovado } from "@/lib/saas/provar-tenant";
import type { DbExecutor } from "@/lib/db/contracts";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Contexto = { params: Promise<{ id: string }> };

const comGestao = (tenant: TenantComprovado) => tenant.papelAtual === "REPRESENTANTE_AUTORIZADO";

/** Projeção atual do perfil só para Gestão; sem Gestão, null (nenhum dado do perfil ainda não publicado). */
async function contratadaPara(tx: DbExecutor, tenant: TenantComprovado, data: Awaited<ReturnType<typeof lerImportacaoContrato>>) {
  if (!comGestao(tenant) || !data.revisao || data.situacao !== "RASCUNHO") return null;
  return contratadaEfetiva(tx, tenant.empresaComprovada, data.revisao.conteudo);
}

export async function GET(request: NextRequest, contexto: Contexto) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const id = z.string().uuid().parse((await contexto.params).id);
    const data = await withTenantTransaction(sessao, request.nextUrl.searchParams.get("empresaId"), async (tx, tenant) => {
      const lido = await lerImportacaoContrato(tx, tenant.empresaComprovada, id);
      return { ...lido, contratadaEfetiva: await contratadaPara(tx, tenant, lido) };
    });
    return jsonNoStore({ ok: true, data: { ...data, problemas: data.revisao ? problemasDoConteudo(data.revisao.conteudo) : [] } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest, contexto: Contexto) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const id = z.string().uuid().parse((await contexto.params).id);
    const dados = corpoPatchModeloSchema.parse(await request.json());
    const data = await withTenantTransaction(sessao, dados.empresaId ?? null, async (tx, tenant) => {
      exigirGestaoNoTenant(tenant, "Apenas o proprietário pode revisar o modelo de contrato.");
      const salvo = await salvarRevisaoContrato(tx, { empresaId: tenant.empresaComprovada, usuarioId: sessao.usuario_id, requestId: randomUUID() }, id, dados.versao, dados.revisao);
      return { ...salvo, contratadaEfetiva: await contratadaPara(tx, tenant, salvo) };
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
    const pedido = acaoModeloSchema.parse(await request.json());
    if (pedido.acao === "previa") {
      // Dados fictícios do contratante; a contratada é composta no servidor (Gestão) ou fica a do modelo, marcada.
      const previa = await withTenantTransaction(sessao, pedido.empresaId ?? null, async (tx, tenant) => {
        if (!comGestao(tenant)) return { conteudo: pedido.conteudo, conferida: null };
        const efetiva = await contratadaEfetiva(tx, tenant.empresaComprovada, pedido.conteudo);
        if (efetiva.estado === "ERRO") throw new ModeloContratoError("PERFIL_INDISPONIVEL", efetiva.erro, 409);
        return { conteudo: aplicarContratada(pedido.conteudo, efetiva), conferida: conferidaDe(efetiva) };
      });
      const pdf = previaModeloContrato(previa.conteudo, { semPerfil: !previa.conferida });
      const cabecalhos: Record<string, string> = { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="previa-contrato-${id.slice(0, 8)}.pdf"`, "Cache-Control": "no-store" };
      if (previa.conferida) {
        cabecalhos["X-Contratada-Origem"] = previa.conferida.origem;
        cabecalhos["X-Contratada-Perfil-Versao"] = previa.conferida.perfilVersao == null ? "" : String(previa.conferida.perfilVersao);
        cabecalhos["X-Contratada-Sha256"] = previa.conferida.sha256;
      }
      return new Response(new Uint8Array(pdf), { headers: cabecalhos });
    }
    const data = await withTenantTransaction(sessao, pedido.empresaId ?? null, async (tx, tenant) => {
      exigirGestaoNoTenant(tenant, "Apenas o proprietário pode publicar o modelo de contrato.");
      const ctx = { empresaId: tenant.empresaComprovada, usuarioId: sessao.usuario_id, requestId: randomUUID() };
      if (pedido.acao === "descartar") { await descartarImportacaoContrato(tx, ctx, id); return { descartado: true }; }
      return publicarModeloContrato(tx, ctx, id, pedido.versao, { revisadoPorPessoa: true }, pedido.contratadaConferida);
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
