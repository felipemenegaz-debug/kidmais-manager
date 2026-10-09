import type { Metadata } from 'next';
import { configuracaoSite, ROTA_SITE } from './configuracao';
import { comercial } from './catalogo';
export function metadataSite(rota = ROTA_SITE): Metadata {
    const { origem } = configuracaoSite();
    const title = 'Kidmais Manager — gestão para buffet infantil';
    const description = `Agenda, orçamento online, contratos e recebimentos para organizar seu buffet infantil. Conheça os recursos disponíveis e comece seu teste de ${comercial.testeDias} dias.`;
    const url = origem ? `${origem}${rota}` : rota;
    return {
        title, description,
        ...(origem ? { metadataBase: new URL(origem) } : {}),
        alternates: { canonical: url },
        openGraph: { type: 'website', title, description, locale: 'pt_BR', siteName: 'Kidmais Manager', url, images: [{ url: `${origem ?? ''}/site/og-site-venda.png`, width: 1200, height: 630, alt: 'Kidmais Manager — Seu buffet vende até de madrugada. Sem planilha.' }] },
        twitter: { card: 'summary_large_image', title, description, images: [`${origem ?? ''}/site/og-site-venda.png`] },
    };
}
