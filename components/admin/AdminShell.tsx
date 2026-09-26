'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './shell.module.css';
import tokens from './tokens.module.css';
import Link from 'next/link';
import KidmaisBrand from '@/components/layout/KidmaisBrand';
import { gruposNavegacao, itemAtivo, itensNavegacao } from '@/lib/admin/navegacao';

export default function AdminShell({ children, classeFonte = '' }: {
    children: React.ReactNode;
    classeFonte?: string;
}) {
    const raiz = `${tokens.tema} ${classeFonte} ${styles.shell}`;
    const path = usePathname();
    const [name, setName] = useState<string | null>(null);
    const [configurar, setConfigurar] = useState(false);
    const [aberto, setAberto] = useState(false);
    const menuRef = useRef<HTMLButtonElement>(null);
    const fecharRef = useRef<HTMLButtonElement>(null);
    const devolverFoco = useRef(false);
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
        if (!aberto) {
            if (devolverFoco.current) {
                devolverFoco.current = false;
                menuRef.current?.focus();
            }
            return;
        }
        fecharRef.current?.focus();
        const rolagem = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const largo = window.matchMedia('(min-width: 801px)');
        function tecla(evento: KeyboardEvent) {
            if (evento.key !== 'Escape')
                return;
            devolverFoco.current = true;
            setAberto(false);
        }
        function redimensionar() {
            if (largo.matches)
                setAberto(false);
        }
        document.addEventListener('keydown', tecla);
        largo.addEventListener('change', redimensionar);
        return () => {
            document.body.style.overflow = rolagem;
            document.removeEventListener('keydown', tecla);
            largo.removeEventListener('change', redimensionar);
        };
    }, [aberto]);
    if (path === '/admin/login')
        return <div className={raiz}>{children}</div>;
    if (!name)
        return <p>Verificando sessão…</p>;
    const itens = itensNavegacao(configurar);
    function fechar() {
        devolverFoco.current = true;
        setAberto(false);
    }
    return <div className={raiz}>
        <div className={styles.barra} inert={aberto}>
            <button ref={menuRef} className={styles.menu} type="button" aria-expanded={aberto} aria-controls="menu-admin" onClick={() => setAberto(true)}>Abrir menu</button>
        </div>
        <aside id="menu-admin" className={styles.sidebar} data-aberto={aberto}>
            <button ref={fecharRef} className={styles.fechar} type="button" aria-controls="menu-admin" onClick={fechar}>Fechar menu</button>
            <div className={styles.marca}><KidmaisBrand subtitle="Gestão de festas" href="/admin/contratos" /></div>
            <header className={styles.conta}>
                <p>{name}</p>
                <button type="button" onClick={async () => {
                    const res = await adminFetch('/api/admin/autenticacao', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'logout' }) });
                    if (res.ok) {
                        setAberto(false);
                        setName(null);
                        router.replace('/admin/login');
                        router.refresh();
                    }
                }}>Sair</button>
            </header>
            <nav aria-label="Menu administrativo">
                {gruposNavegacao(itens).map((secao, indice) => {
                    const rotulo = `menu-admin-grupo-${indice}`;
                    return <div key={secao.grupo} className={styles.secao} role="group" aria-labelledby={rotulo}>
                        <p id={rotulo} className={styles.grupo}>{secao.grupo}</p>
                        {secao.itens.map((item) => <Link key={item.href} href={item.href} aria-current={itemAtivo(path, item.href, itens) ? 'page' : undefined} onClick={() => setAberto(false)}>{item.rotulo}</Link>)}
                    </div>;
                })}
            </nav>
        </aside>
        <div className={styles.conteudo} inert={aberto}>{children}</div>
    </div>;
}
