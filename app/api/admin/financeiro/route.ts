import type { NextRequest } from "next/server";
import { listarContasPagar, listarRecebiveis, recebidoNoMes, resumo } from "@/lib/financeiro/servico";
import { consultarFinanceiro, hojeIso } from "@/lib/financeiro/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const hoje = hojeIso();
  return consultarFinanceiro(request, async (tx, tenant) => {
    const empresaId = tenant.empresaComprovada;
    const recebiveis = await listarRecebiveis(tx, empresaId, hoje);
    const contas = await listarContasPagar(tx, empresaId, hoje);
    const recebido = await recebidoNoMes(tx, empresaId, hoje);
    return {
      resumo: resumo(recebiveis, contas, recebido, hoje),
      recebimentos: recebiveis.filter((item) => item.saldoCentavos > 0).slice(0, 5),
      pagamentos: contas.filter((item) => item.status === "A pagar" || item.status === "Vencido").slice(0, 5),
      alertas: [
        ...recebiveis.filter((item) => item.status === "Vencido").slice(0, 3).map((item) => `${item.cliente} está em atraso`),
        ...contas.filter((item) => item.status === "Vencido").slice(0, 3).map((item) => `${item.descricao} venceu`),
      ],
    };
  });
}
