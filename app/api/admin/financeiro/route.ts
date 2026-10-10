import type { NextRequest } from "next/server";
import { periodoSelecionado } from "@/lib/financeiro/calculos";
import { listarContasPagar, listarRecebiveis, pagoNoPeriodo, recebidoNoPeriodo, resumo } from "@/lib/financeiro/servico";
import { consultarFinanceiro, hojeIso } from "@/lib/financeiro/http";
import { recursoIncluido } from "@/lib/assinatura/recursos-plano";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const hoje = hojeIso();
  const periodo = periodoSelecionado(hoje, "mes");
  return consultarFinanceiro(request, async (tx, tenant) => {
    const empresaId = tenant.empresaComprovada;
    const recebiveis = await listarRecebiveis(tx, empresaId, hoje);
    // Contas a pagar só entram no resumo quando o plano as inclui; os dados existentes não são apagados.
    const financeiroCompleto = await recursoIncluido(tx, empresaId, "FINANCEIRO_COMPLETO");
    const contas = financeiroCompleto ? await listarContasPagar(tx, empresaId, hoje) : [];
    const recebido = await recebidoNoPeriodo(tx, empresaId, periodo.inicio, periodo.fim);
    const pago = financeiroCompleto ? await pagoNoPeriodo(tx, empresaId, periodo.inicio, periodo.fim) : 0;
    return {
      periodo,
      financeiroCompleto,
      resumo: resumo(recebiveis, contas, recebido, hoje, pago),
      recebimentos: recebiveis.filter((item) => item.saldoCentavos > 0).slice(0, 5),
      pagamentos: contas.filter((item) => item.status === "A pagar" || item.status === "Vencido").slice(0, 5),
      alertas: [
        ...recebiveis.filter((item) => item.status === "Vencido").slice(0, 3).map((item) => `${item.cliente} está em atraso`),
        ...contas.filter((item) => item.status === "Vencido").slice(0, 3).map((item) => `${item.descricao} venceu`),
      ],
    };
  });
}
