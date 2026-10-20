import type { Metadata } from 'next';
import { configuracaoSite, ROTA_SITE } from './configuracao';
import { comercial, statusDosRecursos } from './catalogo';
export function metadataSite(rota = ROTA_SITE): Metadata {
    const { origem } = configuracaoSite();
    const planos = rota === '/planos';
    const title = planos ? 'Planos do Kidmais Manager — Essencial, Profissional e Premium' : 'Kidmais Manager — gestão para buffet infantil';
    // A descrição para buscadores não tem selo "Em breve": só cita o que está disponível.
    const modulos = statusDosRecursos(['orcamento']) === 'disponivel' ? 'Agenda, orçamento online, contratos e recebimentos' : 'Agenda, clientes, contratos e recebimentos';
    const description = planos
        ? `Compare os planos Essencial, Profissional e Premium do Kidmais Manager para buffet infantil, com teste de ${comercial.testeDias} dias e condição de fundador.`
        : `${modulos} para organizar seu buffet infantil. Conheça os recursos disponíveis e comece seu teste de ${comercial.testeDias} dias.`;
    const url = origem ? `${origem}${rota}` : rota;
    return {
        title, description,
        ...(origem ? { metadataBase: new URL(origem) } : {}),
        alternates: { canonical: url },
        openGraph: { type: 'website', title, description, locale: 'pt_BR', siteName: 'Kidmais Manager', url, images: [{ url: `${origem ?? ''}/site/og-site-venda.png`, width: 1200, height: 630, alt: 'Kidmais Manager — Seu buffet vende até de madrugada. Sem planilha.' }] },
        twitter: { card: 'summary_large_image', title, description, images: [`${origem ?? ''}/site/og-site-venda.png`] },
    };
}
