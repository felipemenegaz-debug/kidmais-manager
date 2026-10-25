import { NextRequest } from "next/server";
import { pacotesComPrecoAConfirmar } from "@/lib/comercial/pacote-precos";
import { definirSaloesPacote, escoposDaEmpresa, saloesDaEmpresa } from "@/lib/agenda/configuracao-unidade";
import { listarConfiguracoesAgendaAtivas } from "@/lib/disponibilidade/repositories/disponibilidade.repository";
import { z } from "zod";
import { DURACAO_MAXIMA_MINUTOS, DURACAO_MINIMA_MINUTOS } from "@/lib/disponibilidade/services/horario.utils";
import { MOTIVOS_PACOTE, motivoOu } from "@/lib/comercial/motivos-pacote";
import { salvarPacoteComercial, duplicarPacoteComercial } from "@/lib/comercial/pacote-comercial";
import { criarPacoteAdmin, listarPacotesAdmin } from "@/lib/comercial/pacotes-admin";
import { exigirGestaoNoTenant, withTenantTransaction } from "@/lib/saas/provar-tenant";
import { catalogoBuffetPorEmpresa } from "@/lib/comercial/catalogo-buffet-estrutura";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuid = z.string().uuid();
const codigo = z.string().trim().min(2).max(50).regex(/^[A-Z][A-Z0-9_]+$/);
const nome = z.string().trim().min(1).max(160);
const texto = z.string().trim().max(2000).nullable();
// Limite único de duração (parecer do Astra, P2-2): o mesmo da agenda — 5 min a 23h59.
const duracao = z.number().int().min(DURACAO_MINIMA_MINUTOS).max(DURACAO_MAXIMA_MINUTOS).nullable();
const criar = z.object({
  acao: z.literal("criar"),
  empresaId: uuid,
  codigo: codigo.optional(),
  nome,
  descricao: texto,
  duracaoMinutos: duracao,
  motivo: z.string().trim().min(3).max(500).optional(),
}).strict();
const duplicar = z.object({
  acao: z.literal("duplicar"),
  empresaId: uuid,
  origemId: uuid,
  codigo: codigo.optional(),
  motivo: z.string().trim().min(3).max(500).optional(),
}).strict();
const faixa = z.object({
  convidadosMin: z.number().int().positive().max(10000),
  convidadosMax: z.number().int().positive().max(10000).nullable(),
  valor: z.string().trim().min(1).max(20),
}).strict();
const ponto = z.object({
  convidados: z.number().int().positive().max(10000),
  valor: z.string().trim().min(1).max(20),
}).strict();
const salvar = z.object({
  acao: z.literal("salvar"),
  empresaId: uuid,
  id: uuid.optional(),
  nome,
  descricao: texto,
  duracaoMinutos: z.number().int().min(DURACAO_MINIMA_MINUTOS).max(DURACAO_MAXIMA_MINUTOS),
  convidadosMinimos: z.number().int().positive().max(10000),
  convidadosMaximos: z.number().int().positive().max(10000),
  disponibilidade: z.array(z.object({
    dia: z.number().int().min(1).max(7),
    horarioId: uuid,
  }).strict()).max(168),
  faixas: z.array(faixa).max(40).nullable(),
  /** 092: preço por quantidades cheias; substitui faixas. conversao marca a confirmação das faixas antigas. */
  pontos: z.array(ponto).max(40).optional(),
  conversao: z.boolean().optional(),
  categorias: z.array(z.object({
    categoriaId: uuid,
    escolhas: z.number().int().min(0).max(30),
  }).strict()).max(40),
  itens: z.array(uuid).max(200).optional(),
  /** 093: salões permitidos (vazio = todos). Ausente mantém os atuais. */
  saloes: z.array(uuid).max(30).optional(),
  motivo: z.string().trim().min(3).max(500).optional(),
}).strict();
const corpo = z.discriminatedUnion("acao", [criar, duplicar, salvar]);

async function horariosDosEscopos(
  tx: Parameters<typeof listarConfiguracoesAgendaAtivas>[0],
  empresaId: string,
  escopos: Awaited<ReturnType<typeof escoposDaEmpresa>>,
) {
  const vistos = new Map<string, { id: string; nome: string; inicio: string; fim: string; dias: number[] | null }>();
  for (const escopo of escopos) {
    for (const h of await listarConfiguracoesAgendaAtivas(tx, { empresaId, estabelecimentoId: escopo.estabelecimentoId })) {
      if (vistos.has(h.id)) continue;
      vistos.set(h.id, {
        id: h.id,
        nome: escopos.length > 1 ? `${h.nome} (${escopo.nome})` : h.nome,
        inicio: h.horarioInicioPadrao,
        fim: h.horarioFimPadrao,
        dias: h.diasSemana ?? null,
      });
    }
  }
  return [...vistos.values()];
}

/** 056: a autoridade de escrita é o papel da membership, conferido dentro da transação do tenant. */
async function exigirEscrita(request: NextRequest) {
  return exigirApiAdminCrmDisponivel(request);
}

export async function GET(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const data = await withTenantTransaction(
      sessao,
      request.nextUrl.searchParams.get("empresaId"),
      async (tx, tenant) => {
        const empresaId = tenant.empresaComprovada;
        const pacotes = await listarPacotesAdmin(tx, empresaId);
        // 093: os horários que valem para cada unidade da empresa (com o nome da unidade quando há mais de uma);
        // sem a 093, os horários ativos de sempre.
        const escopos = await escoposDaEmpresa(tx, empresaId);
        const horarios = escopos.length > 0
          ? { rows: await horariosDosEscopos(tx, empresaId, escopos) }
          : await tx.query(
            `SELECT id, nome, horario_inicio_padrao::text AS inicio, horario_fim_padrao::text AS fim
               FROM configuracao_agenda
              WHERE ativo
              ORDER BY ordem_exibicao, nome`,
          );
        const saloes = await saloesDaEmpresa(tx, empresaId);
        // Com a 078, só o catálogo da própria empresa; antes dela, o catálogo global de sempre.
        const porEmpresa = await catalogoBuffetPorEmpresa(tx);
        const filtro = porEmpresa ? "AND empresa_id = $1::uuid" : "";
        const parametros = porEmpresa ? [empresaId] : [];
        const categorias = await tx.query(
          `SELECT id, nome FROM buffet_categorias WHERE ativo ${filtro} ORDER BY ordem_exibicao, nome`, parametros,
        );
        const itens = await tx.query(
          `SELECT id, nome, categoria_id FROM buffet_itens WHERE ativo ${filtro} ORDER BY ordem_exibicao, nome`, parametros,
        );
        // 092: pacotes que ainda cobram por faixas e esperam o buffet confirmar a conversão para quantidades cheias.
        const precosAConfirmar = [...await pacotesComPrecoAConfirmar(tx, empresaId)];
        return {
          pacotes,
          precosAConfirmar,
          horarios: horarios.rows,
          saloes,
          categorias: categorias.rows,
          itens: itens.rows,
        };
      },
    );
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirEscrita(request);
    const bruto = await request.json();
    const pedido = z.object({ empresaId: z.string().optional() }).passthrough().parse(bruto);
    const data = await withTenantTransaction(sessao, pedido.empresaId, async (tx, tenant) => {
      exigirGestaoNoTenant(tenant, "Apenas o proprietário pode editar pacotes.");
      const input = corpo.parse({ ...bruto, empresaId: tenant.empresaComprovada });
      const ctx = {
        empresaId: tenant.empresaComprovada,
        usuarioId: sessao.usuario_id,
        requestId: crypto.randomUUID(),
        motivo: input.motivo,
      };
      if (input.acao === "criar") {
        const criado = await criarPacoteAdmin(tx, { ...input, empresaId: tenant.empresaComprovada }, ctx);
        // Mesma regra do salvar (parecer do Astra, 25/10/2026): na agenda por salão, pacote novo sem salão é recusado.
        await definirSaloesPacote(tx, tenant.empresaComprovada, criado.id, []);
        return criado;
      }
      if (input.acao === "duplicar") {
        return duplicarPacoteComercial(tx, input.origemId, {
          ...ctx,
          motivo: motivoOu(input.motivo, MOTIVOS_PACOTE.duplicado),
        });
      }
      const { pontos, conversao, ...resto } = input;
      return salvarPacoteComercial(tx, { ...resto, faixas: pontos ? { pontos, conversao } : resto.faixas }, ctx);
    });
    return jsonNoStore({ ok: true, data }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
