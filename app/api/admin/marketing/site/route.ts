import type { NextRequest } from "next/server";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { exigirCapacidadeMarketing } from "@/lib/marketing/capacidades";
import { exigirUnidadeDaEmpresa } from "@/lib/marketing/campanhas";
import { lerCorpo, parametroUuid, rotaMarketing } from "@/lib/marketing/http";
import { listarDominios } from "@/lib/marketing/dominios/servico";
import { dominiosPersonalizadosAtivos, servirDominioSimulado } from "@/lib/marketing/dominios/hosts";
import { listarImagens } from "@/lib/marketing/site/imagens";
import { sitesPublicosAtivos } from "@/lib/marketing/site/publico";
import { origemPlataforma, urlCanonica } from "@/lib/marketing/site/seo";
import {
  ACOES_DE_PUBLICACAO, alterarEndereco, criarSite, despublicarSite, esquemaAcaoSite, pacotesDisponiveis, publicarSite, resolverPacotesPublicados, salvarRascunho, siteDaEmpresa,
  siteDaUnidade, versoesDoSite,
} from "@/lib/marketing/site/servico";
import type { DbExecutor } from "@/lib/db/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function painelSite(tx: DbExecutor, empresaId: string, unidadeId: string | null) {
  const site = await siteDaUnidade(tx, empresaId, unidadeId);
  const unidades = (await tx.query<{ id: string; nome: string }>(
    "SELECT id::text, nome FROM estabelecimentos WHERE empresa_id = $1::uuid AND status <> 'DESATIVADO' ORDER BY nome", [empresaId])).rows;
  if (!site) return { site: null, unidades, ambiente: ambiente() };
  const dominios = await listarDominios(tx, empresaId, site.id);
  const principal = dominios.find((d) => d.principal && d.status === "ATIVO") ?? null;
  // Prévia = o que a publicação congelaria agora (pacotes vigentes, preço aprovado de hoje), sem gravar nada.
  const resolvidos = await resolverPacotesPublicados(tx, empresaId, site.rascunho);
  return {
    site,
    previa: { conteudo: { ...site.rascunho, pacotes: resolvidos.pacotes, versao: 0, publicadoEm: "", rascunhoHash: "" }, avisos: resolvidos.avisos },
    unidades,
    imagens: await listarImagens(tx, empresaId, site.id),
    versoes: await versoesDoSite(tx, empresaId, site.id),
    dominios,
    pacotesDisponiveis: await pacotesDisponiveis(tx, empresaId),
    enderecos: {
      plataforma: `${origemPlataforma()}/s/${site.slug}`,
      canonical: urlCanonica(site.slug, principal ? { host: principal.host, simulado: principal.simulado } : null),
      sitemap: `${origemPlataforma()}/s/${site.slug}/sitemap.xml`,
    },
    ambiente: ambiente(),
  };
}

/** Situação dos interruptores (só leitura; os valores vêm do servidor). */
function ambiente() {
  return { sitesPublicos: sitesPublicosAtivos(), dominiosPersonalizados: dominiosPersonalizadosAtivos(process.env), dominioSimuladoServido: servirDominioSimulado(process.env) };
}

export async function GET(request: NextRequest) {
  return rotaMarketing(request, exigirApiAdminCrmDisponivel, { capacidade: "MARKETING_VISUALIZAR" }, async ({ tx, tenant, capacidades }) => {
    const unidadeId = await exigirUnidadeDaEmpresa(tx, tenant.empresaComprovada, parametroUuid(request.nextUrl.searchParams.get("unidadeId")));
    return { ...(await painelSite(tx, tenant.empresaComprovada, unidadeId)), capacidades };
  });
}

export async function POST(request: NextRequest) {
  // O rascunho do site carrega textos maiores: limite próprio de 256 KB.
  return rotaMarketing(request, exigirApiAdminCrmDisponivel, { capacidade: "MARKETING_VISUALIZAR" }, async ({ tx, tenant }) => {
    const acao = esquemaAcaoSite.parse(await lerCorpo(request, 256_000));
    await exigirCapacidadeMarketing(tx, tenant, ACOES_DE_PUBLICACAO.has(acao.acao) ? "MARKETING_SITE_PUBLICAR" : "MARKETING_SITE_EDITAR");
    const empresaId = tenant.empresaComprovada;
    const usuarioId = tenant.usuarioId;
    let avisos: string[] = [];
    let siteId: string;
    if (acao.acao === "criar") siteId = (await criarSite(tx, empresaId, usuarioId, acao.unidadeId ?? null, acao.slug)).id;
    else if (acao.acao === "salvar") siteId = (await salvarRascunho(tx, empresaId, usuarioId, acao.siteId, acao.rascunhoVersao, acao.conteudo)).id;
    else if (acao.acao === "endereco") siteId = (await alterarEndereco(tx, empresaId, usuarioId, acao.siteId, acao.rascunhoVersao, acao.slug)).id;
    else if (acao.acao === "publicar") { const r = await publicarSite(tx, empresaId, usuarioId, acao.siteId, acao.rascunhoVersao); siteId = r.site.id; avisos = r.avisos; }
    else siteId = (await despublicarSite(tx, empresaId, usuarioId, acao.siteId)).id;
    const site = await siteDaEmpresa(tx, empresaId, siteId);
    return { ...(await painelSite(tx, empresaId, site.unidadeId)), avisos };
  });
}
