import type { NextRequest } from "next/server";
import { z } from "zod";
import { FORMAS } from "@/lib/financeiro/calculos";
import { consultarFinanceiro, hojeIso } from "@/lib/financeiro/http";
import { cancelarConta, criarContaPagar, editarContaPagar, listarContasPagar, pagarConta, pagoNoPeriodo } from "@/lib/financeiro/servico";
import { periodoSelecionado } from "@/lib/financeiro/calculos";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const criar = z.object({
  acao: z.literal("criar"),
  descricao: z.string().trim().min(1).max(160),
  favorecido: z.string().trim().max(160).optional(),
  categoriaId: z.string().uuid(),
  valor: z.number().positive(),
  vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  competencia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  festaId: z.string().uuid().optional(),
  forma: z.enum(FORMAS).optional(),
  observacao: z.string().max(500).optional(),
  recorrente: z.boolean().optional(),
  chave: z.string().min(8).max(160),
}).strict();

const editar = z.object({
  acao: z.literal("editar"),
  id: z.string().uuid(),
  descricao: z.string().trim().min(1).max(160),
  favorecido: z.string().trim().max(160).optional(),
  categoriaId: z.string().uuid(),
  valor: z.number().positive(),
  vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  observacao: z.string().max(500).optional(),
}).strict();

const pagar = z.object({
  acao: z.literal("pagar"),
  contaId: z.string().uuid(),
  valor: z.number().positive(),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  forma: z.enum(FORMAS),
  observacao: z.string().max(500).optional(),
  chave: z.string().min(8).max(160),
}).strict();

const cancelar = z.object({ acao: z.literal("cancelar"), id: z.string().uuid() }).strict();
const corpo = z.discriminatedUnion("acao", [criar, editar, pagar, cancelar]);

export async function GET(request: NextRequest) {
  const hoje = hojeIso();
  const mes = periodoSelecionado(hoje, "mes");
  return consultarFinanceiro(request, async (tx, tenant) => ({
    contas: await listarContasPagar(tx, tenant.empresaComprovada, hoje),
    pagoMesCentavos: await pagoNoPeriodo(tx, tenant.empresaComprovada, mes.inicio, mes.fim),
    categorias: (await tx.query<{ id: string; nome: string }>(
      `SELECT id::text AS id, nome FROM financeiro_categorias WHERE empresa_id = $1::uuid AND ativo ORDER BY nome`,
      [tenant.empresaComprovada],
    )).rows,
  }));
}

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const input = corpo.parse(await request.json());
    const hoje = hojeIso();
    const data = await withTenantTransaction(sessao, null, async (tx, tenant) => {
      const empresaId = tenant.empresaComprovada;
      if (input.acao === "criar") return criarContaPagar(tx, empresaId, tenant.usuarioId, input);
      if (input.acao === "editar") return editarContaPagar(tx, empresaId, tenant.usuarioId, input.id, input);
      if (input.acao === "pagar") return pagarConta(tx, empresaId, tenant.usuarioId, input);
      await cancelarConta(tx, empresaId, tenant.usuarioId, input.id);
      return listarContasPagar(tx, empresaId, hoje);
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
