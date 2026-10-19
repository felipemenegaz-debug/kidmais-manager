import type { NextRequest } from "next/server";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { lerCorpo, rotaMarketing } from "@/lib/marketing/http";
import { esquemaAcaoCampanha, executarAcaoCampanha, listarCampanhas, PADRAO_POR_CANAL } from "@/lib/marketing/campanhas";
import { exigirOrigemValida, lerOrigens } from "@/lib/marketing/origens";
import { listarSites } from "@/lib/marketing/site/servico";
import { origemPlataforma } from "@/lib/marketing/site/seo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return rotaMarketing(request, exigirApiAdminCrmDisponivel, { capacidade: "MARKETING_VISUALIZAR" }, async ({ tx, tenant, capacidades }) => {
    const empresaId = tenant.empresaComprovada;
    const incluirArquivadas = request.nextUrl.searchParams.get("arquivadas") === "1";
    return {
      campanhas: await listarCampanhas(tx, empresaId, { incluirArquivadas }),
      origens: await lerOrigens(tx, empresaId),
      sites: await listarSites(tx, empresaId),
      unidades: (await tx.query<{ id: string; nome: string }>(
        "SELECT id::text, nome FROM estabelecimentos WHERE empresa_id = $1::uuid AND status <> 'DESATIVADO' ORDER BY nome", [empresaId])).rows,
      padraoPorCanal: PADRAO_POR_CANAL,
      origemPlataforma: origemPlataforma(),
      capacidades,
    };
  });
}

export async function POST(request: NextRequest) {
  return rotaMarketing(request, exigirApiAdminCrmDisponivel, { capacidade: "MARKETING_CAMPANHAS_EDITAR" }, async ({ tx, tenant }) => {
    const acao = esquemaAcaoCampanha.parse(await lerCorpo(request));
    if (acao.acao === "criar" || acao.acao === "editar") await exigirOrigemValida(tx, tenant.empresaComprovada, acao.origemCodigo, { permitirInativa: acao.acao === "editar" });
    return { campanha: await executarAcaoCampanha(tx, tenant.empresaComprovada, tenant.usuarioId, acao) };
  });
}
