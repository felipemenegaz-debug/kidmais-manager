'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './admin.module.css';
import Link from 'next/link';
import KidmaisBrand from '@/components/layout/KidmaisBrand';
import { itemAtivo, itensNavegacao } from '@/lib/admin/navegacao';

export default function AdminShell({ children }: {
    children: React.ReactNode;
}) {
    const path = usePathname();
    const [name, setName] = useState<string | null>(null);
    const [configurar, setConfigurar] = useState(false);
    const [aberto, setAberto] = useState(false);
    const [recolhido, setRecolhido] = useState(false);
    const menuRef = useRef<HTMLButtonElement>(null);
    const painelRef = useRef<HTMLElement>(null);
    const router = useRouter();
    useEffect(() => {
        if (path === '/admin/login')
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
    }, [path, router]);
    useEffect(() => {
        if (!aberto)
            return;
        const foco = painelRef.current?.querySelector<HTMLElement>('a, button');
        foco?.focus();
        function tecla(evento: KeyboardEvent) {
            if (evento.key !== 'Escape')
                return;
            setAberto(false);
            menuRef.current?.focus();
        }
        document.addEventListener('keydown', tecla);
        return () => document.removeEventListener('keydown', tecla);
    }, [aberto]);
    if (path === '/admin/login')
        return <div className={styles.shell}>{children}</div>;
    if (!name)
        return <p>Verificando sessão…</p>;
    const itens = itensNavegacao(configurar);
    const grupos = ['Operação', 'Configurações'] as const;
    function fechar() {
        setAberto(false);
        menuRef.current?.focus();
    }
    return <div className={styles.shell}>
        <button ref={menuRef} className={styles.menu} type="button" aria-expanded={aberto} aria-controls="menu-admin" onClick={() => setAberto((valor) => !valor)}>{aberto ? 'Fechar menu' : 'Abrir menu'}</button>
        {aberto && <button className={styles.cortina} type="button" aria-label="Fechar menu" onClick={fechar} />}
        <aside id="menu-admin" ref={painelRef} className={styles.sidebar} data-aberto={aberto} data-recolhido={recolhido}>
            <KidmaisBrand subtitle="Gestão de festas" href="/admin/contratos" />
            <header className={styles.conta}>
                <p>{name}</p>
                <button type="button" onClick={async () => {
                    const res = await adminFetch('/api/admin/autenticacao', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'logout' }) });
                    if (res.ok) {
                        setName(null);
                        router.replace('/admin/login');
                        router.refresh();
                    }
                }}>Sair</button>
            </header>
            <button className={styles.recolher} type="button" aria-pressed={recolhido} onClick={() => setRecolhido((valor) => !valor)}>{recolhido ? 'Expandir menu' : 'Recolher menu'}</button>
            <nav aria-label="Menu administrativo">
                {grupos.map((grupo) => {
                    const links = itens.filter((item) => item.grupo === grupo);
                    if (links.length === 0)
                        return null;
                    return <div key={grupo}>
                        <p className={styles.grupo}>{grupo}</p>
                        {links.map((item) => <Link key={item.href} href={item.href} aria-current={itemAtivo(path, item.href, itens) ? 'page' : undefined} onClick={() => setAberto(false)}>{item.rotulo}</Link>)}
                    </div>;
                })}
            </nav>
        </aside>
        <div className={styles.conteudo}>{children}</div>
    </div>;
}
