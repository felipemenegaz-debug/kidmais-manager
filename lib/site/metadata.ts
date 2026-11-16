import type { Metadata } from 'next';
import { configuracaoSite, ROTA_SITE } from './configuracao';
import { comercial, visivel } from './catalogo';
export function metadataSite(rota = ROTA_SITE): Metadata {
    const { origem } = configuracaoSite();
    const planos = rota === '/planos';
    const title = planos ? 'Planos do iA.Fest — Essencial, Profissional e Premium' : 'iA.Fest — gestão para buffet infantil';
    // A descrição para buscadores não tem selo "Em breve": só cita o que está disponível.
    const itens = ([['agenda', 'agenda'], ['orcamento', 'orçamento online'], ['clientes', 'clientes'], ['contratos', 'contratos'], ['financeiro', 'recebimentos']] as const).filter(([id]) => visivel([id])).map(([, texto]) => texto);
    const juntos = itens.length < 2 ? itens.join('') : `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`;
    const modulos = juntos ? juntos[0].toUpperCase() + juntos.slice(1) : 'Gestão';
    const description = planos
        ? `Compare os planos Essencial, Profissional e Premium do iA.Fest para buffet infantil, com teste de ${comercial.testeDias} dias e condição de fundador.`
        : `${modulos} para organizar seu buffet infantil. Conheça os recursos disponíveis e comece seu teste de ${comercial.testeDias} dias.`;
    const url = origem ? `${origem}${rota}` : rota;
    return {
        title, description,
        icons: { icon: [{ url: '/site/iafest/simbolo.svg', type: 'image/svg+xml' }] },
        ...(origem ? { metadataBase: new URL(origem) } : {}),
        alternates: { canonical: url },
        openGraph: { type: 'website', title, description, locale: 'pt_BR', siteName: 'iA.Fest', url, images: [{ url: `${origem ?? ''}/site/iafest/apresentacao.png`, width: 1000, height: 1200, alt: 'iA.Fest — Gestão inteligente de buffets e eventos' }] },
        twitter: { card: 'summary_large_image', title, description, images: [`${origem ?? ''}/site/iafest/apresentacao.png`] },
    };
}
