import { NextRequest } from "next/server";
import { z } from "zod";
import {
  agendaConfiguravelInstalada,
  cancelarDesativacao,
  desativarHorarioAPartirDe,
  escopoJaConfigurado,
  escoposDaEmpresa,
  lerAgendaEscopo,
  salvarAgendaEscopo,
} from "@/lib/agenda/configuracao-unidade";
import { exigirGestaoNoTenant, withTenantTransaction } from "@/lib/saas/provar-tenant";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuid = z.string().uuid();
const hora = z.string().regex(/^\d{2}:\d{2}$/);
const salvar = z.object({
  acao: z.literal("salvar"),
  /** Assistente da primeira entrada: qualquer usuário da unidade, só enquanto ela não foi configurada. */
  origem: z.enum(["ASSISTENTE", "CONFIGURACOES"]),
  estabelecimentoId: uuid.nullable(),
  modo: z.enum(["FIXO", "LIVRE"]),
  capacidadeTipo: z.enum(["POR_HORARIO", "POR_SALAO"]),
  limiteFestasDia: z.number().int().min(1).max(50).nullable(),
  intervaloMinimoMinutos: z.number().int().min(0).max(480),
  saloes: z.array(z.object({
    id: uuid.optional(),
    nome: z.string().trim().min(1).max(80),
    capacidadeConvidados: z.number().int().positive().max(10000).nullable(),
  }).strict()).max(30),
  horarios: z.array(z.object({
    id: uuid.optional(),
    nome: z.string().trim().min(1).max(80),
    inicio: hora,
    fim: hora,
    dias: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    capacidade: z.number().int().min(1).max(20),
    saloes: z.array(z.string().trim().min(1).max(80)).max(30),
  }).strict()).max(20),
}).strict();
const desativar = z.object({ acao: z.literal("desativar"), horarioId: uuid, aPartirDe: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();
const cancelar = z.object({ acao: z.literal("cancelar_desativacao"), horarioId: uuid }).strict();
const corpo = z.discriminatedUnion("acao", [salvar, desativar, cancelar]);

const GESTAO = "Apenas quem tem Gestão pode alterar a agenda.";

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const parametros = request.nextUrl.searchParams;
    const data = await withTenantTransaction(sessao, parametros.get("empresaId"), async (tx, tenant) => {
      const empresaId = tenant.empresaComprovada;
      const gestao = tenant.papelAtual === "REPRESENTANTE_AUTORIZADO";
      if (!(await agendaConfiguravelInstalada(tx))) return { instalada: false, gestao, escopos: [], agenda: null };
      const escopos = await escoposDaEmpresa(tx, empresaId);
      if (parametros.get("pendentes") === "1") return { instalada: true, gestao, escopos, pendentes: escopos.filter((e) => !e.configurado) };
      const pedida = parametros.get("unidadeId");
      const escolhido = escopos.find((e) => e.estabelecimentoId === (pedida || null)) ?? escopos[0];
      const agenda = escolhido ? await lerAgendaEscopo(tx, empresaId, escolhido.estabelecimentoId) : null;
      return { instalada: true, gestao, escopos, agenda };
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const bruto = await request.json();
    const pedido = z.object({ empresaId: z.string().optional() }).passthrough().parse(bruto);
    const { empresaId: _ignorado, ...resto } = bruto as Record<string, unknown>;
    void _ignorado;
    const input = corpo.parse(resto);
    const data = await withTenantTransaction(sessao, pedido.empresaId, async (tx, tenant) => {
      const ctx = { empresaId: tenant.empresaComprovada, usuarioId: sessao.usuario_id, requestId: crypto.randomUUID() };
      if (input.acao === "salvar") {
        const assistente = input.origem === "ASSISTENTE"
          && !(await escopoJaConfigurado(tx, ctx.empresaId, input.estabelecimentoId));
        if (!assistente) exigirGestaoNoTenant(tenant, GESTAO);
        const { acao: _acao, origem: _origem, ...dados } = input;
        void _acao;
        void _origem;
        return salvarAgendaEscopo(tx, dados, ctx, assistente ? "ASSISTENTE" : "CONFIGURACOES");
      }
      exigirGestaoNoTenant(tenant, GESTAO);
      if (input.acao === "desativar") return desativarHorarioAPartirDe(tx, ctx, input.horarioId, input.aPartirDe);
      await cancelarDesativacao(tx, ctx, input.horarioId);
      return { cancelado: true };
    });
    return jsonNoStore({ ok: true, data }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
