import type { MetadataRoute } from 'next';
import { configuracaoSite, ROTA_SITE, type AmbienteSite } from './configuracao.ts';

/** Páginas comerciais que a plataforma pede para indexar. Termos e privacidade seguem acessíveis, fora do sitemap. */
export const PAGINAS_INDEXADAS = [ROTA_SITE, '/planos'] as const;

/**
 * robots.txt do Host da plataforma (domínios de clientes têm o próprio em /sd/<host>/robots.txt). Áreas privadas já
 * respondem `X-Robots-Tag: noindex` (next.config.ts); bloquear o rastreio delas aqui esconderia esse cabeçalho.
 */
export function robotsDaPlataforma(env: AmbienteSite = process.env): MetadataRoute.Robots {
    const { origem } = configuracaoSite(env);
    return { rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/preview-ux/'] }, ...(origem ? { sitemap: `${origem}/sitemap.xml` } : {}) };
}

/** Sem origem confiável (SITE_URL/ADMIN_AUTH_ORIGIN), não publica URL relativa nem inventa domínio: sitemap vazio. */
export function sitemapDaPlataforma(env: AmbienteSite = process.env): MetadataRoute.Sitemap {
    const { origem } = configuracaoSite(env);
    if (!origem) return [];
    return PAGINAS_INDEXADAS.map((rota) => ({ url: `${origem}${rota}`, changeFrequency: 'weekly' as const, priority: rota === ROTA_SITE ? 1 : 0.8 }));
}
