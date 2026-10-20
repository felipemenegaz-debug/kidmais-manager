'use client';
import { useSearchParams } from 'next/navigation';
import type { ConteudoPublicado } from '@/lib/marketing/site/conteudo';
import SitePublicoPagina from '@/components/marketing/site/SitePublicoPagina';
import { EstadoCarga, useMarketing } from './comum';
import styles from './marketing.module.css';

type Dados = { site: { slug: string; estado: string } | null; previa?: { conteudo: ConteudoPublicado; avisos: string[] } };

/**
 * Prévia do RASCUNHO, só com sessão administrativa (rota /admin: noindex pelo next.config). Imagens vêm da rota
 * administrativa; o formulário não envia. Nada daqui é público.
 */
export default function MarketingSitePrevia() {
  const unidadeId = useSearchParams().get('unidadeId');
  const { dados, falha, carregando, recarregar } = useMarketing<Dados>(`/api/admin/marketing/site${unidadeId ? `?unidadeId=${encodeURIComponent(unidadeId)}` : ''}`);
  if (!dados) return <main className={styles.pagina}><EstadoCarga carregando={carregando} falha={falha} aoTentar={recarregar} /></main>;
  if (!dados.site || !dados.previa) return <main className={styles.pagina}><p className={styles.vazio}>Ainda não há rascunho de site para esta unidade.</p></main>;
  return <div>
    <p className={styles.aviso} role="status" style={{ margin: 0, borderRadius: 0 }}>Prévia do rascunho — não é a página publicada. {dados.previa.avisos.join(' ')}</p>
    <SitePublicoPagina conteudo={dados.previa.conteudo} base="" previa urlImagem={(id) => `/api/admin/marketing/site/imagens/${id}`}
      acaoFormulario="#" captura={{}} datasLivres={null} />
  </div>;
}
