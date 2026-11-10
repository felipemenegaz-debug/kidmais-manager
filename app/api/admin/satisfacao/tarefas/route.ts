import type { NextRequest } from "next/server";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { parametroUuid } from "@/lib/marketing/http";
import { rotaSatisfacaoAdmin } from "@/lib/satisfacao/admin-http";
import { SatisfacaoError } from "@/lib/satisfacao/erros";
import { listarTarefas } from "@/lib/satisfacao/tarefas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Retornos das notas baixas no escopo do tenant (Gestão: todas as unidades; Equipe: unidades com SATISFACAO_TRATAR).
 *  PS-4: `estado` (ABERTA padrão | CONCLUIDA) aplicado no SQL antes do limite e `cursor` da página seguinte. */
export async function GET(request: NextRequest) {
  return rotaSatisfacaoAdmin(request, exigirApiAdminCrmDisponivel, async ({ tx, tenant }) => {
    const bruto = request.nextUrl.searchParams.get("unidadeId");
    const unidade = parametroUuid(bruto);
    if (bruto !== null && bruto !== "" && !unidade) throw new SatisfacaoError("NAO_ENCONTRADO", "Unidade não encontrada.", 404);
    const estado = request.nextUrl.searchParams.get("estado") ?? "ABERTA";
    if (estado !== "ABERTA" && estado !== "CONCLUIDA") throw new SatisfacaoError("DADOS_INVALIDOS", "Estado inválido.", 400);
    return listarTarefas(tx, tenant, { estabelecimentoId: unidade, estado, cursor: request.nextUrl.searchParams.get("cursor") });
  });
}
