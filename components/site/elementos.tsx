import type { ReactNode } from 'react';
import { CADASTRO_FECHADO, type ConfiguracaoSite } from '@/lib/site/configuracao';
import { cx } from './estilos';

export function Cadastro({ aberto, children, destaque = true }: { aberto: boolean; children?: ReactNode; destaque?: boolean }) {
    return aberto ? <a className={cx('btn', destaque ? 'btn-primary' : '')} href="/cadastro">{children ?? <>Começar teste grátis <span aria-hidden="true">↗</span></>}</a>
        : <p className={cx('closed')} data-cadastro-fechado>{CADASTRO_FECHADO}</p>;
}
export type ContatoSite = Pick<ConfiguracaoSite, 'contato' | 'fundador'> & Partial<Pick<ConfiguracaoSite, 'emailHref' | 'fundadorEmail'>>;
/** WhatsApp quando configurado; sem ele, e-mail de atendimento (o botão flutuante é só do WhatsApp). */
export function Contato({ config, fundador = false, flutuante = false }: { config: ContatoSite; fundador?: boolean; flutuante?: boolean }) {
    const whatsapp = fundador ? config.fundador : config.contato;
    if (whatsapp) return <a className={cx('btn', flutuante ? 'btn-lilac wa-float' : '')} href={whatsapp} target="_blank" rel="noopener noreferrer">{fundador ? 'Quero ser fundador' : 'Falar com a equipe'}</a>;
    const email = flutuante ? null : fundador ? config.fundadorEmail : config.emailHref;
    return email ? <a className={cx('btn')} href={email} data-contato-email>{fundador ? 'Quero ser fundador' : 'Falar com a equipe por e-mail'}</a> : null;
}
/** Barra fixa no celular: teste grátis (só com o cadastro aberto) e contato (só com canal configurado). */
export function BarraCelular({ aberto, config }: { aberto: boolean; config: ContatoSite }) {
    const contato = config.contato ?? config.emailHref ?? null;
    if (!aberto && !contato) return null;
    return <div className={cx('barraCelular')} role="group" aria-label="Ações rápidas">
        {aberto && <a className={cx('btn', 'btn-primary')} href="/cadastro">Teste grátis</a>}
        {contato && <a className={cx('btn')} href={contato} {...(config.contato ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>Falar com a equipe</a>}
    </div>;
}
