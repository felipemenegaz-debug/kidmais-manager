import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { db } from '@/lib/db/postgres';
import { resolverPagina, type Via } from '@/lib/marketing/site/rotas-publicas';
import { dadosEstruturados, jsonLdSeguro, metadataSite } from '@/lib/marketing/site/seo';
import { sugerirDatasVagas } from '@/lib/marketing/sugestoes';
import { capturarCampanha, hojeSaoPaulo } from '@/lib/marketing/utm';
import SitePublicoPagina from './SitePublicoPagina';
import type { CapturaFormulario } from './FormularioOrcamento';

const NAO_ENCONTRADO: Metadata = { title: 'Página não encontrada', robots: { index: false, follow: false } };

export async function metadataDaPagina(via: Via | null, hostOriginal: string | null = null): Promise<Metadata> {
  const pagina = via ? await resolverPagina(via, process.env, hostOriginal).catch(() => null) : null;
  if (!pagina) return NAO_ENCONTRADO;
  const c = pagina.site.conteudo;
  const primeira = c.galeria[0]?.imagemId ?? c.identidade.logoImagemId;
  return metadataSite(c, {
    canonical: pagina.canonical, indexavel: pagina.indexavel,
    imagemAbsoluta: primeira ? `${pagina.origem}${pagina.base}/imagens/${primeira}` : null,
  });
}

/** Página pública (servidor): versão publicada + UTM validada da URL + datas livres (se o buffet escolheu mostrar). */
export default async function PaginaPublica({ via, parametros, hostOriginal = null }: { via: Via | null; parametros: Record<string, string | string[] | undefined>; hostOriginal?: string | null }) {
  const pagina = via ? await resolverPagina(via, process.env, hostOriginal).catch(() => null) : null;
  if (!pagina) notFound();
  if (pagina.redirecionarPara) permanentRedirect(pagina.redirecionarPara);
  const c = pagina.site.conteudo;
  const captura = capturarCampanha(parametros);
  const formulario: CapturaFormulario = { ...captura.utm, ...(captura.codigoCampanha ? { kc: captura.codigoCampanha } : {}) };
  let datasLivres: Array<{ data: string; diaSemana: number }> | null = null;
  if (c.formulario.ativo && c.formulario.mostrarDatasLivres) {
    const sugestao = await sugerirDatasVagas(db(), pagina.site.empresaId, pagina.site.estabelecimentoId, hojeSaoPaulo(), 45).catch(() => null);
    datasLivres = sugestao?.disponivel ? sugestao.datas.filter((d) => d.fimDeSemana).slice(0, 8).map((d) => ({ data: d.data, diaSemana: d.diaSemana })) : null;
  }
  const imagens = [c.identidade.logoImagemId, ...c.galeria.map((g) => g.imagemId)].filter((v): v is string => Boolean(v))
    .map((id) => `${pagina.origem}${pagina.base}/imagens/${id}`);
  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdSeguro(dadosEstruturados(c, pagina.canonical, imagens)) }} />
    <SitePublicoPagina conteudo={c} base={pagina.base} urlImagem={(id) => `${pagina.base}/imagens/${id}`}
      acaoFormulario={`/api/publico/marketing/${pagina.site.slug}/contato`} captura={formulario} datasLivres={datasLivres} />
  </>;
}
