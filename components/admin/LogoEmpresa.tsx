'use client';
/* eslint-disable @next/next/no-img-element -- Logo interna em data URL validada pelo servidor. */
import { createContext, useContext, useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './shell.module.css';

/** Logo aplicada da empresa ativa, lida uma vez pelo AdminShell e compartilhada com as telas (Dashboard). */
export const LogoEmpresaContext = createContext<string | null>(null);

export function useLogoEmpresaAtiva() {
    return useContext(LogoEmpresaContext);
}

/** Lê a logo aplicada (e relê ao aplicar uma nova em Perfil da empresa). Inativa: nenhuma leitura. */
export function useLogoEmpresa(ativa: boolean) {
    const [logo, setLogo] = useState<string | null>(null);
    useEffect(() => {
        if (!ativa) return;
        let ativo = true; let pedido: AbortController | null = null;
        async function carregar() {
            pedido?.abort(); pedido = new AbortController();
            try {
                const resposta = await adminFetch('/api/admin/configuracoes/perfil-empresa/logo', {signal:pedido.signal});
                const corpo = await resposta.json();
                if (ativo) setLogo(resposta.ok && corpo.ok ? corpo.data.logoDataUrl ?? null : null);
            } catch { /* Sem a logo, o cartão da conta mostra as iniciais da empresa. */ }
        }
        void carregar(); window.addEventListener('kidmais-logo-aplicada',carregar);
        return () => { ativo=false;pedido?.abort();window.removeEventListener('kidmais-logo-aplicada',carregar); };
    },[ativa]);
    return logo;
}

/** Iniciais das duas primeiras palavras do nome ("Buffet Encantado" → "BE"). */
export function iniciaisEmpresa(nome: string) {
    const palavras = nome.trim().split(/\s+/).filter(Boolean);
    return palavras.slice(0, 2).map((palavra) => palavra[0]).join('').toUpperCase() || '?';
}

/** Marca da empresa em quadrado: a logo sobre fundo claro (legível no painel escuro) ou, sem logo, as iniciais. */
// decorativa: o nome da empresa já está escrito ao lado (Dashboard); o texto alternativo fica só no cartão da conta.
export function MarcaEmpresa({ logo, nome, className, decorativa = false }: { logo: string | null; nome: string; className?: string; decorativa?: boolean }) {
    // Guarda qual logo falhou ao carregar: uma logo nova volta a ser tentada.
    const [falhou, setFalhou] = useState<string | null>(null);
    if (logo && falhou !== logo) return <span className={`${styles.marcaEmpresa} ${className ?? ''}`}><img src={logo} alt={decorativa ? '' : 'Logo da empresa'} onError={()=>setFalhou(logo)} /></span>;
    return <span className={`${styles.marcaEmpresa} ${styles.marcaIniciais} ${className ?? ''}`} aria-hidden="true">{iniciaisEmpresa(nome)}</span>;
}

/** Marca do sistema no topo do menu: símbolo, divisória e nome do iA.Fest, centralizados na vertical. A logo da empresa fica no cartão da conta. */
export default function LogoEmpresa() {
    return <span className={styles.marcaSistema}><img className={styles.marcaSimbolo} src="/assets/iafest/simbolo-painel.png" alt="" aria-hidden="true" width={160} height={183} /><span className={styles.marcaDivisoria} aria-hidden="true" /><img className={styles.marcaNome} src="/assets/iafest/logotipo-painel.png" alt="iA.Fest" width={360} height={99} /></span>;
}
