import type { NextRequest } from "next/server";
import { z } from "zod";
import { FORMAS } from "@/lib/financeiro/calculos";
import { consultarFinanceiro, hojeIso } from "@/lib/financeiro/http";
import { registrarRecebimentoPagamento } from "@/lib/pagamentos/services/pagamento.service";
import { auditarRecebimento, listarRecebiveis, prepararBaixa, resumo, recebidoNoMes } from "@/lib/financeiro/servico";
import { apiErrorResponse, jsonNoStore } from "@/lib/http/api-response";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { withTenantTransaction } from "@/lib/saas/provar-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const baixa = z.object({
  parcelaId: z.string().uuid(),
  valor: z.number().positive(),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  forma: z.enum(FORMAS),
  taxa: z.number().min(0).optional(),
  observacao: z.string().max(500).optional(),
  chave: z.string().min(8).max(160),
}).strict();

export async function GET(request: NextRequest) {
  const hoje = hojeIso();
  return consultarFinanceiro(request, async (tx, tenant) => {
    const recebiveis = await listarRecebiveis(tx, tenant.empresaComprovada, hoje);
    const recebido = await recebidoNoMes(tx, tenant.empresaComprovada, hoje);
    return { recebiveis, resumo: resumo(recebiveis, [], recebido, hoje) };
  });
}

export async function POST(request: NextRequest) {
  try {
    const sessao = await exigirApiAdminCrmDisponivel(request);
    const input = baixa.parse(await request.json());
    const preparado = await withTenantTransaction(sessao, null, (tx, tenant) => prepararBaixa(tx, tenant.empresaComprovada, input));
    const resultado = await registrarRecebimentoPagamento({
      pagamentoId: preparado.pagamentoId,
      meioPagamento: preparado.meio,
      valorBruto: preparado.valorReais,
      recebidoEm: `${input.data}T00:00:00.000Z`,
      chaveIdempotencia: input.chave,
      observacoes: input.observacao ?? null,
      metadataProvedor: { forma: input.forma, taxaCentavos: preparado.taxa },
      confirmarAgora: true,
      alocacoes: [{ parcelaId: preparado.parcelaId, valor: preparado.valorReais }],
    }, { usuarioId: sessao.usuario_id, origem: "financeiro", requestId: input.chave });
    await withTenantTransaction(sessao, null, (tx, tenant) => auditarRecebimento(tx, tenant.empresaComprovada, tenant.usuarioId, preparado.parcelaId, preparado.valorReais));
    const data = { reutilizado: resultado.reutilizado, liquidoCentavos: preparado.liquidoCentavos };
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
