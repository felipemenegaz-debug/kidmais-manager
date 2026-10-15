import type { NextRequest } from "next/server";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { MarketingError } from "@/lib/marketing/erros";
import { lerCorpo, parametroUuid, rotaMarketing } from "@/lib/marketing/http";
import { esquemaAcaoDominio, executarAcaoDominio, listarDominios } from "@/lib/marketing/dominios/servico";
import { provedorDoAmbiente } from "@/lib/marketing/dominios/provedor";
import { siteDaEmpresa } from "@/lib/marketing/site/servico";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Domínio personalizado: fluxo completo com provedor SIMULADO (nenhuma chamada externa, nenhum DNS real alterado). */
export async function GET(request: NextRequest) {
  return rotaMarketing(request, exigirApiAdminCrmDisponivel, { capacidade: "MARKETING_VISUALIZAR" }, async ({ tx, tenant }) => {
    const siteId = parametroUuid(request.nextUrl.searchParams.get("siteId"));
    if (!siteId) throw new MarketingError("DADOS_INVALIDOS", "Informe o site.", 400);
    await siteDaEmpresa(tx, tenant.empresaComprovada, siteId);
    return { dominios: await listarDominios(tx, tenant.empresaComprovada, siteId), provedor: "SIMULADO" };
  });
}

export async function POST(request: NextRequest) {
  return rotaMarketing(request, exigirApiAdminCrmDisponivel, { capacidade: "MARKETING_DOMINIO_CONFIGURAR" }, async ({ tx, tenant }) => {
    const acao = esquemaAcaoDominio.parse(await lerCorpo(request));
    const provedor = provedorDoAmbiente(tx);
    const resultado = await executarAcaoDominio(tx, tenant.empresaComprovada, tenant.usuarioId, acao, provedor);
    const siteId = acao.acao === "solicitar" ? acao.siteId
      : (await tx.query<{ site_id: string }>("SELECT site_id::text FROM marketing_dominios WHERE id = $1::uuid AND empresa_id = $2::uuid", [acao.id, tenant.empresaComprovada])).rows[0]?.site_id;
    return { resultado, dominios: siteId ? await listarDominios(tx, tenant.empresaComprovada, siteId) : [] };
  });
}
