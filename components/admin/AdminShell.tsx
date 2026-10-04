'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { adminFetch } from '@/lib/http/admin-fetch';
import { registrarContextoEmpresa, reiniciarContextoEmpresa } from '@/lib/http/contexto-empresa-cliente';
import styles from './shell.module.css';
import tokens from './tokens.module.css';
import Link from 'next/link';
import { AdminIcon, type AdminIconName } from './AdminIcon';
import { itemAtivo, itensNavegacao, type PermissoesNavegacao } from '@/lib/admin/navegacao';

type ContextoSessaoCliente = { empresas: { id: string; nome: string; papel: string }[]; empresaAtual: { id: string; nome: string } | null; gestaoNaEmpresa: boolean; plataforma: boolean; desenvolvedor: boolean; selecaoNecessaria: boolean };
import { BotaoPerguntarKidmais, PerguntarKidmaisProvider } from './inteligencia/PerguntarKidmais';
import LogoEmpresa from './LogoEmpresa';
import AvisoContexto from './AvisoContexto';

export default function AdminShell({ children, vitrine }: {
    children: React.ReactNode;
    vitrine?: { nome: string; caminho: string };
}) {
    const pathReal = usePathname();
    const path = vitrine?.caminho ?? pathReal;
    const [name, setName] = useState<string | null>(vitrine?.nome ?? null);
    // D7: Configurações da empresa seguem o papel NA EMPRESA selecionada; as da instalação, a autoridade de plataforma.
    const [permissoes, setPermissoes] = useState<PermissoesNavegacao>({ gestaoEmpresa: Boolean(vitrine), plataforma: Boolean(vitrine) });
    const [empresa, setEmpresa] = useState<{ nome: string; selecaoNecessaria: boolean; desenvolvedor: boolean } | null>(null);
    const [contexto, setContexto] = useState<ContextoSessaoCliente | null>(null);
    const [trocando, setTrocando] = useState(false);
    const [erroEmpresa, setErroEmpresa] = useState('');
    const [aberto, setAberto] = useState(false);
    const menuRef = useRef<HTMLButtonElement>(null);
    const painelRef = useRef<HTMLElement>(null);
    const router = useRouter();
    useEffect(() => {
        if (vitrine || path === '/admin/login')
            return;
        let alive = true;
        const carregar = () => fetch('/api/admin/autenticacao', { cache: 'no-store' }).then(r => r.json()).then(b => {
            if (!b.ok || !b.data.usuarioId) {
                setName(null);
                window.location.replace('/admin/login');
            }
            else if (alive) {
                const c = b.data.contexto as ContextoSessaoCliente | undefined;
                if (!registrarContextoEmpresa(b.data.sessaoId, c?.empresaAtual?.id ?? null)) return;
                setName(b.data.nome);
                setContexto(c ?? null);
                setPermissoes({ gestaoEmpresa: Boolean(c?.gestaoNaEmpresa), plataforma: Boolean(c?.plataforma) });
                setEmpresa(c ? { nome: c.empresaAtual?.nome ?? '', selecaoNecessaria: c.selecaoNecessaria, desenvolvedor: c.desenvolvedor } : null);
            }
        }).catch(() => router.replace('/admin/login'));
        void carregar();
        const timer = window.setInterval(carregar, 15000);
        const foco = () => { void carregar(); };
        const outraAba = (e: StorageEvent) => { if (e.key === 'kidmais-contexto-alterado') reiniciarContextoEmpresa('A empresa ativa foi trocada em outra aba. Os dados desta tela foram descartados.'); };
        window.addEventListener('focus', foco);
        window.addEventListener('storage', outraAba);
        return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', foco); window.removeEventListener('storage', outraAba); };
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
    const itens = itensNavegacao(permissoes);
    const grupos = ['Principal', 'Operação', 'Financeiro', 'Configurações'] as const;
    async function escolherEmpresa(id: string) {
        if (!id || trocando) return;
        setTrocando(true); setErroEmpresa('');
        try {
            const res = await adminFetch('/api/admin/autenticacao', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ acao: 'selecionar-empresa', empresaId: id }) });
            const b = await res.json();
            if (!res.ok || !b.ok) throw Error(b.erro ?? 'Não foi possível trocar de empresa.');
            try { localStorage.setItem('kidmais-contexto-alterado', String(Date.now())); } catch { /* Sem armazenamento, foco/poll revalidam as outras abas. */ }
            reiniciarContextoEmpresa();
        } catch (e) { setErroEmpresa(e instanceof Error ? e.message : 'Não foi possível trocar de empresa.'); setTrocando(false); }
    }
    const seletor = contexto && contexto.empresas.length > 0 ? <label className={styles.seletorEmpresa}>Empresa ativa
        <select aria-label="Empresa ativa" disabled={trocando} value={contexto.empresaAtual?.id ?? ''} onChange={e => void escolherEmpresa(e.target.value)}>
            <option value="" disabled>Selecione uma empresa</option>
            {contexto.empresas.map(e => <option key={e.id} value={e.id}>{e.nome} · {e.papel === 'REPRESENTANTE_AUTORIZADO' ? 'Gestão' : 'Equipe'}</option>)}
        </select>
    </label> : null;
    function fechar() {
        setAberto(false);
        menuRef.current?.focus();
    }
    return <div className={`${tokens.tema} ${styles.shell}`}><PerguntarKidmaisProvider>
        <button ref={menuRef} className={styles.menu} type="button" aria-expanded={aberto} aria-controls="menu-admin" onClick={() => setAberto((valor) => !valor)}><span>{aberto ? 'Fechar menu' : 'Abrir menu'}</span><b aria-hidden="true">{aberto ? '×' : '☰'}</b></button>
        {aberto && <button className={styles.cortina} type="button" aria-label="Fechar menu" onClick={fechar} />}
        <aside id="menu-admin" ref={painelRef} className={styles.sidebar} data-aberto={aberto}>
            <Link className={styles.brand} href="/admin/dashboard" aria-label="Dashboard" onClick={() => setAberto(false)}><LogoEmpresa vitrine={Boolean(vitrine)} /></Link>
            <nav aria-label="Menu administrativo">
                {grupos.map((grupo) => {
                    const links = itens.filter((item) => item.grupo === grupo);
                    if (links.length === 0) return null;
                    return <div key={grupo}><p className={styles.grupo}>{grupo}</p>{links.map((item) => <Link key={item.href} href={item.href} aria-current={itemAtivo(path, item.href, itens) ? 'page' : undefined} onClick={() => setAberto(false)}><span className={styles.navIcon}><AdminIcon name={iconeDaRota(item.href)} /></span>{item.rotulo}</Link>)}</div>;
                })}
            </nav>
            <BotaoPerguntarKidmais className={styles.perguntar} aoAbrir={() => setAberto(false)}><span className={styles.navIcon} aria-hidden="true">✦</span>Perguntar ao Kidmais</BotaoPerguntarKidmais>
            <footer className={styles.conta}>
                <div className={styles.identidade}><span className={styles.avatar} aria-hidden="true">{name.slice(0,1).toUpperCase()}</span><div><p>{name}</p><small>{permissoes.gestaoEmpresa ? 'Gestão' : 'Equipe'}{empresa?.nome ? ` · ${empresa.nome}` : ''}</small></div></div>
                {seletor}
                {empresa?.selecaoNecessaria && <p className={styles.avisoEmpresa} role="status">Selecione uma empresa para continuar.</p>}
                {empresa?.desenvolvedor && <Link className={styles.perfilLink} href="/desenvolvedor" onClick={() => setAberto(false)}>Painel do desenvolvedor</Link>}
                <Link className={styles.perfilLink} href="/admin/perfil" aria-current={path === '/admin/perfil' ? 'page' : undefined} onClick={() => setAberto(false)}>Meu perfil e senha</Link>
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
        <div className={styles.conteudo}><AvisoContexto />{erroEmpresa && <p role="alert">{erroEmpresa}</p>}{trocando ? <p role="status">Trocando de empresa…</p> : !vitrine && !contexto?.empresaAtual && path !== '/admin/perfil'
            ? <section><h1>Empresa ativa</h1><p>Escolha a empresa que deseja acessar.</p>{seletor}{contexto?.empresas.length === 0 && <p>Nenhuma empresa com acesso ativo.</p>}</section>
            : children}</div>
    </PerguntarKidmaisProvider></div>;
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
