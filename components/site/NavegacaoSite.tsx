'use client';
import { useRef, useState, type ReactNode } from 'react';
import { cx } from './estilos';

export default function NavegacaoSite({ children, prefixo, aberto }: { children: ReactNode; prefixo: string; aberto: boolean }) {
    const [aberta, setAberta] = useState(false);
    const menuBotao = useRef<HTMLButtonElement>(null);
    const links = [['diferenciais', 'Diferenciais'], ['recursos', 'Recursos'], ['saloes', 'Agenda'], ['financeiro', 'Financeiro'], ['importacao', 'Importação'], ['marketing', 'Marketing'], ['wall-e', 'Wall-e'], ['convite', 'Convites'], ['planos', 'Planos'], ['duvidas', 'Dúvidas']];
    return <header className={cx('header', 'headerCompacto')}><div className={cx('wrap')}>
        {children}
        <button ref={menuBotao} className={cx('menuToggle')} type="button" aria-expanded={aberta} aria-controls="site-menu" onClick={() => setAberta(!aberta)}>{aberta ? 'Fechar' : 'Menu'} <span aria-hidden="true">{aberta ? '×' : '☰'}</span></button>
        <nav id="site-menu" className={cx('nav', aberta ? 'menuAberto' : '')} aria-label="Principal" onClick={() => setAberta(false)} onKeyDown={event => { if (event.key === 'Escape') { setAberta(false); menuBotao.current?.focus(); } }}>
            {links.map(([id, nome]) => <a key={id} href={`${id === 'planos' ? '' : prefixo}#${id}`}>{nome}</a>)}
            <a className={cx('login')} href="/admin/login">Entrar</a>
            {aberto && <a className={cx('btn', 'btn-primary', 'btn-sm')} href="/cadastro">Testar grátis</a>}
        </nav>
    </div></header>;
}
