import type { NextRequest } from "next/server";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { MarketingError } from "@/lib/marketing/erros";
import { parametroData, parametroUuid, rotaMarketing } from "@/lib/marketing/http";
import { exigirUnidadeDaEmpresa, listarCampanhas } from "@/lib/marketing/campanhas";
import { painelMarketing, periodoPadrao, validarPeriodo } from "@/lib/marketing/metricas";
import { lerOrigens } from "@/lib/marketing/origens";
import { sugerirDatasVagas } from "@/lib/marketing/sugestoes";
import { hojeSaoPaulo } from "@/lib/marketing/utm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Visão geral: números do período com definições, origens e sugestão de datas vagas (somente leitura da agenda). */
export async function GET(request: NextRequest) {
  return rotaMarketing(request, exigirApiAdminCrmDisponivel, { capacidade: "MARKETING_VISUALIZAR" }, async ({ tx, tenant, capacidades }) => {
    const hoje = hojeSaoPaulo();
    const padrao = periodoPadrao(hoje);
    const de = parametroData(request.nextUrl.searchParams.get("de")) ?? padrao.de;
    const ate = parametroData(request.nextUrl.searchParams.get("ate")) ?? padrao.ate;
    if (!validarPeriodo(de, ate)) throw new MarketingError("MARKETING_PERIODO_INVALIDO", "Período inválido (até 2 anos, início antes do fim).", 400);
    const unidadePedida = parametroUuid(request.nextUrl.searchParams.get("unidadeId"));
    const empresaId = tenant.empresaComprovada;
    const unidadeId = await exigirUnidadeDaEmpresa(tx, empresaId, unidadePedida);
    const painel = await painelMarketing(tx, empresaId, { de, ate, unidadeId });
    const unidades = (await tx.query<{ id: string; nome: string }>(
      "SELECT id::text, nome FROM estabelecimentos WHERE empresa_id = $1::uuid AND status <> 'DESATIVADO' ORDER BY nome", [empresaId])).rows;
    const origens = await lerOrigens(tx, empresaId);
    const campanhas = (await listarCampanhas(tx, empresaId, { unidadeId })).map((c) => ({ id: c.id, nome: c.nome, status: c.status }));
    const sugestoes = await sugerirDatasVagas(tx, empresaId, unidadeId, hoje);
    return { hoje, painel, unidades, origens, campanhas, sugestoes, capacidades };
  });
}
