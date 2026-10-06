'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from '@/components/admin/shell.module.css';
import tokens from '@/components/admin/tokens.module.css';
import { AdminIcon } from '@/components/admin/AdminIcon';
import AvisoContexto from '@/components/admin/AvisoContexto';
import { lembrarCsrf, sairDaSessao } from '@/components/admin/sair';

const ITENS = [
    { href: '/desenvolvedor', rotulo: 'Resumo', icone: 'dashboard' as const },
    { href: '/desenvolvedor/interessadas', rotulo: 'Interessadas', icone: 'contact' as const },
    { href: '/desenvolvedor/empresas', rotulo: 'Contratantes', icone: 'users' as const },
    { href: '/desenvolvedor/atividade', rotulo: 'Atividade', icone: 'history' as const },
];

type AcessosDaConta = { empresasAtivas: number; carregado: boolean };

/**
 * Shell do painel do desenvolvedor: área separada da administração das empresas, mesmo padrão visual do Admin.
 * "Ir para o Admin" só aparece quando a conta tem alguma empresa com acesso ativo (a concessão de desenvolvedor não
 * dá acesso operacional a empresa nenhuma); sem empresa, a conta ainda sai, acessa o perfil e usa o painel.
 */
export default function DesenvolvedorShell({ nome, children }: { nome: string; children: React.ReactNode }) {
    const path = usePathname();
    const [aberto, setAberto] = useState(false);
    const [saindo, setSaindo] = useState(false);
    const [acessos, setAcessos] = useState<AcessosDaConta>({ empresasAtivas: 0, carregado: false });
    const menuRef = useRef<HTMLButtonElement>(null);
    const ativo = (href: string) => href === '/desenvolvedor' ? path === href : path === href || path.startsWith(`${href}/`);
    useEffect(() => {
        let vivo = true;
        fetch('/api/admin/autenticacao', { cache: 'no-store' }).then((r) => r.json()).then((b) => {
            if (!vivo) return;
            lembrarCsrf(b?.data?.csrf);
            const empresas = (b?.data?.contexto?.empresas as unknown[] | undefined) ?? [];
            setAcessos({ empresasAtivas: empresas.length, carregado: true });
        }).catch(() => { if (vivo) setAcessos({ empresasAtivas: 0, carregado: true }); });
        return () => { vivo = false; };
    }, [path]);
    useEffect(() => {
        if (!aberto)
            return;
        function tecla(evento: KeyboardEvent) {
            if (evento.key !== 'Escape')
                return;
            setAberto(false);
            menuRef.current?.focus();
        }
        document.addEventListener('keydown', tecla);
        return () => document.removeEventListener('keydown', tecla);
    }, [aberto]);
    return <div className={`${tokens.tema} ${styles.shell}`}>
        <button ref={menuRef} className={styles.menu} type="button" aria-expanded={aberto} aria-controls="menu-desenvolvedor" onClick={() => setAberto((v) => !v)}><span>{aberto ? 'Fechar menu' : 'Abrir menu'}</span><b aria-hidden="true">{aberto ? '×' : '☰'}</b></button>
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
                    {acessos.carregado && acessos.empresasAtivas > 0 && <Link href="/admin/dashboard" onClick={() => setAberto(false)}><span className={styles.navIcon}><AdminIcon name="settings" /></span>Ir para o Admin</Link>}
                </div>
            </nav>
            <footer className={styles.conta}>
                <div className={styles.identidade}><span className={styles.avatar} aria-hidden="true">{nome.slice(0, 1).toUpperCase()}</span><div><p>{nome}</p><small>Desenvolvedor</small></div></div>
                {acessos.carregado && acessos.empresasAtivas === 0 && <p className={styles.avisoEmpresa} role="status">Sem empresa com acesso ativo no Admin.</p>}
                <button type="button" disabled={saindo} onClick={() => { if (saindo) return; setSaindo(true); void sairDaSessao().finally(() => setSaindo(false)); }}><AdminIcon name="logout" size={12} /> {saindo ? 'Saindo…' : 'Sair'}</button>
            </footer>
        </aside>
        <div className={styles.conteudo}><AvisoContexto />{children}</div>
    </div>;
}
