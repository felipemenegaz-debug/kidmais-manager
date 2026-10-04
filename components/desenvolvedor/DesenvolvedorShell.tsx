'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import styles from '@/components/admin/shell.module.css';
import tokens from '@/components/admin/tokens.module.css';
import { AdminIcon } from '@/components/admin/AdminIcon';
import { adminFetch } from '@/lib/http/admin-fetch';

const ITENS = [
    { href: '/desenvolvedor', rotulo: 'Resumo', icone: 'dashboard' as const },
    { href: '/desenvolvedor/interessadas', rotulo: 'Interessadas', icone: 'contact' as const },
    { href: '/desenvolvedor/empresas', rotulo: 'Contratantes', icone: 'users' as const },
];

/** Shell do painel do desenvolvedor: área separada da administração das empresas, mesmo padrão visual do Admin. */
export default function DesenvolvedorShell({ nome, children }: { nome: string; children: React.ReactNode }) {
    const path = usePathname();
    const router = useRouter();
    const [aberto, setAberto] = useState(false);
    const ativo = (href: string) => href === '/desenvolvedor' ? path === href : path === href || path.startsWith(`${href}/`);
    return <div className={`${tokens.tema} ${styles.shell}`}>
        <button className={styles.menu} type="button" aria-expanded={aberto} aria-controls="menu-desenvolvedor" onClick={() => setAberto((v) => !v)}><span>{aberto ? 'Fechar menu' : 'Abrir menu'}</span><b aria-hidden="true">{aberto ? '×' : '☰'}</b></button>
        {aberto && <button className={styles.cortina} type="button" aria-label="Fechar menu" onClick={() => setAberto(false)} />}
        <aside id="menu-desenvolvedor" className={styles.sidebar} data-aberto={aberto}>
            <Link className={styles.brand} href="/desenvolvedor" onClick={() => setAberto(false)}>
                <span className={styles.brandMark} aria-hidden="true">K</span>
                <span className={styles.brandText}>Kidmais<span>Desenvolvedor</span></span>
            </Link>
            <nav aria-label="Menu do painel do desenvolvedor">
                <div><p className={styles.grupo}>Plataforma</p>
                    {ITENS.map((item) => <Link key={item.href} href={item.href} aria-current={ativo(item.href) ? 'page' : undefined} onClick={() => setAberto(false)}>
                        <span className={styles.navIcon}><AdminIcon name={item.icone} /></span>{item.rotulo}
                    </Link>)}
                </div>
                <div><p className={styles.grupo}>Conta</p>
                    <Link href="/admin/perfil" onClick={() => setAberto(false)}><span className={styles.navIcon}><AdminIcon name="profile" /></span>Meu perfil e senha</Link>
                    <Link href="/admin/dashboard" onClick={() => setAberto(false)}><span className={styles.navIcon}><AdminIcon name="settings" /></span>Ir para o Admin</Link>
                </div>
            </nav>
            <footer className={styles.conta}>
                <div className={styles.identidade}><span className={styles.avatar} aria-hidden="true">{nome.slice(0, 1).toUpperCase()}</span><div><p>{nome}</p><small>Desenvolvedor</small></div></div>
                <button type="button" onClick={async () => {
                    const res = await adminFetch('/api/admin/autenticacao', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'logout' }) });
                    if (res.ok) {
                        router.replace('/admin/login');
                        router.refresh();
                    }
                }}><AdminIcon name="logout" size={12} /> Sair</button>
            </footer>
        </aside>
        <div className={styles.conteudo}>{children}</div>
    </div>;
}
