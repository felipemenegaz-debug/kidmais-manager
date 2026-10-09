import type { ReactNode } from 'react';
import { statusDosRecursos, type RecursoId } from '@/lib/site/catalogo';
import { CADASTRO_FECHADO, type ConfiguracaoSite } from '@/lib/site/configuracao';
import { cx } from './estilos';

/** Todas as menções dependentes de disponibilidade passam por este componente. */
export function Recurso({ ids, children }: { ids: readonly RecursoId[]; children: ReactNode }) {
    const status = statusDosRecursos(ids);
    return <span className={cx('statusGroup')} data-recursos={ids.join(' ')} data-status={status}>
        {children}{status === 'em_breve' && <> <span className={cx('soon')}>Em breve</span></>}
    </span>;
}
export function Cadastro({ aberto, children, destaque = true }: { aberto: boolean; children?: ReactNode; destaque?: boolean }) {
    return aberto ? <a className={cx('btn', destaque ? 'btn-primary' : '')} href="/cadastro">{children ?? <>Começar teste grátis <span aria-hidden="true">↗</span></>}</a>
        : <p className={cx('closed')} data-cadastro-fechado>{CADASTRO_FECHADO}</p>;
}
export function Contato({ config, fundador = false, flutuante = false }: { config: Pick<ConfiguracaoSite, 'contato' | 'fundador'>; fundador?: boolean; flutuante?: boolean }) {
    const href = fundador ? config.fundador : config.contato;
    return href ? <a className={cx('btn', flutuante ? 'btn-lilac wa-float' : '')} href={href} target="_blank" rel="noopener noreferrer">{fundador ? 'Quero ser fundador' : 'Falar com a equipe'}</a> : null;
}
