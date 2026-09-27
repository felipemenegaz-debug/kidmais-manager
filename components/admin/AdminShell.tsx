'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './shell.module.css';
import tokens from './tokens.module.css';
import Link from 'next/link';
import { AdminIcon, type AdminIconName } from './AdminIcon';
import { itemAtivo, itensNavegacao } from '@/lib/admin/navegacao';

export default function AdminShell({ children, vitrine }: {
    children: React.ReactNode;
    vitrine?: { nome: string; caminho: string };
}) {
    const pathReal = usePathname();
    const path = vitrine?.caminho ?? pathReal;
    const [name, setName] = useState<string | null>(vitrine?.nome ?? null);
    const [configurar, setConfigurar] = useState(Boolean(vitrine));
    const [aberto, setAberto] = useState(false);
    const menuRef = useRef<HTMLButtonElement>(null);
    const painelRef = useRef<HTMLElement>(null);
    const router = useRouter();
    useEffect(() => {
        if (vitrine || path === '/admin/login')
            return;
        let alive = true;
        fetch('/api/admin/autenticacao', { cache: 'no-store' }).then(r => r.json()).then(b => {
            if (!b.ok || !b.data.usuarioId)
                router.replace('/admin/login');
            else if (alive) {
                setName(b.data.nome);
                setConfigurar(b.data.papel === 'REPRESENTANTE_AUTORIZADO');
            }
        }).catch(() => router.replace('/admin/login'));
        return () => { alive = false; };
    }, [path, router, vitrine]);
    useEffect(() => {
        if (!aberto)
            return;
        const foco = painelRef.current?.querySelector<HTMLElement>('a, button');
        foco?.focus();
        const overflowAnterior = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        function tecla(evento: KeyboardEvent) {
            if (evento.key === 'Tab') {
                const controles = [menuRef.current, ...Array.from(painelRef.current?.querySelectorAll<HTMLElement>('a, button') ?? [])].filter((item): item is HTMLElement => item !== null);
                const primeiro = controles[0];
                const ultimo = controles[controles.length - 1];
                if (evento.shiftKey && document.activeElement === primeiro) {
                    evento.preventDefault();
                    ultimo?.focus();
                } else if (!evento.shiftKey && document.activeElement === ultimo) {
                    evento.preventDefault();
                    primeiro?.focus();
                }
            }
            if (evento.key !== 'Escape')
                return;
            setAberto(false);
            menuRef.current?.focus();
        }
        document.addEventListener('keydown', tecla);
        return () => {
            document.removeEventListener('keydown', tecla);
            document.body.style.overflow = overflowAnterior;
        };
    }, [aberto]);
    if (path === '/admin/login')
        return <div className={`${tokens.tema} ${styles.shell}`}>{children}</div>;
    if (!name)
        return <div className={tokens.tema}><p className={styles.carregando}>Verificando sessão…</p></div>;
    const itens = itensNavegacao(configurar);
    const grupos = ['Principal', 'Operação', 'Financeiro', 'Configurações'] as const;
    function fechar() {
        setAberto(false);
        menuRef.current?.focus();
    }
    return <div className={`${tokens.tema} ${styles.shell}`}>
        <button ref={menuRef} className={styles.menu} type="button" aria-expanded={aberto} aria-controls="menu-admin" onClick={() => setAberto((valor) => !valor)}><span>{aberto ? 'Fechar menu' : 'Abrir menu'}</span><b aria-hidden="true">{aberto ? '×' : '☰'}</b></button>
        {aberto && <button className={styles.cortina} type="button" aria-label="Fechar menu" onClick={fechar} />}
        <aside id="menu-admin" ref={painelRef} className={styles.sidebar} data-aberto={aberto}>
            <Link className={styles.brand} href="/admin/dashboard" onClick={() => setAberto(false)}><span className={styles.brandMark}><AdminIcon name="cake" size={18} /></span><span className={styles.brandText}>Kidmais<span>Admin</span></span></Link>
            <nav aria-label="Menu administrativo">
                {grupos.map((grupo) => {
                    const links = itens.filter((item) => item.grupo === grupo);
                    if (links.length === 0) return null;
                    return <div key={grupo}><p className={styles.grupo}>{grupo}</p>{links.map((item) => <Link key={item.href} href={item.href} aria-current={itemAtivo(path, item.href, itens) ? 'page' : undefined} onClick={() => setAberto(false)}><span className={styles.navIcon}><AdminIcon name={iconeDaRota(item.href)} /></span>{item.rotulo}</Link>)}</div>;
                })}
            </nav>
            <footer className={styles.conta}>
                <div className={styles.identidade}><span className={styles.avatar} aria-hidden="true">{name.slice(0,1).toUpperCase()}</span><div><p>{name}</p><small>{configurar ? 'Proprietário' : 'Equipe'}</small></div></div>
                <button type="button" onClick={async () => {
                    const res = await adminFetch('/api/admin/autenticacao', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'logout' }) });
                    if (res.ok) {
                        setName(null);
                        router.replace('/admin/login');
                        router.refresh();
                    }
                }}><AdminIcon name="logout" size={12} /> Sair</button>
            </footer>
        </aside>
        <div className={styles.conteudo}>{children}</div>
    </div>;
}

function iconeDaRota(href: string): AdminIconName {
    if (href.includes('perfil-empresa')) return 'profile';
    if (href.includes('tabelas-preco')) return 'prices';
    if (href.includes('tabela-pacotes')) return 'pdf';
    if (href.includes('pacotes')) return 'packages';
    if (href.includes('catalogo')) return 'buffet';
    if (href.includes('clientes') || href.includes('acessos')) return 'users';
    if (href.includes('contratos')) return 'contract';
    if (href.includes('festas')) return 'cake';
    if (href.includes('disponibilidade')) return 'calendar';
    if (href.includes('whatsapp')) return 'contact';
    if (href.includes('dashboard')) return 'dashboard';
    if (href.includes('contas-receber')) return 'receive';
    if (href.includes('contas-pagar')) return 'pay';
    if (href.includes('fluxo-caixa')) return 'wallet';
    if (href.includes('relatorios')) return 'reports';
    if (href.endsWith('/financeiro')) return 'chart';
    return 'settings';
}
