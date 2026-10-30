'use client';
/* eslint-disable @next/next/no-img-element -- Logo interna em data URL validada pelo servidor. */
import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './shell.module.css';

export default function LogoEmpresa({ vitrine = false }: { vitrine?: boolean }) {
    const [logo, setLogo] = useState<string | null>(null);
    useEffect(() => {
        if (vitrine) return;
        let ativo = true; let pedido: AbortController | null = null;
        async function carregar() {
            pedido?.abort(); pedido = new AbortController();
            try {
                const resposta = await adminFetch('/api/admin/configuracoes/perfil-empresa/logo', {signal:pedido.signal});
                const corpo = await resposta.json();
                if (ativo) setLogo(resposta.ok && corpo.ok ? corpo.data.logoDataUrl ?? null : null);
            } catch { /* A marca padrão permanece se a logo não puder ser consultada. */ }
        }
        void carregar(); window.addEventListener('kidmais-logo-aplicada',carregar);
        return () => { ativo=false;pedido?.abort();window.removeEventListener('kidmais-logo-aplicada',carregar); };
    },[vitrine]);
    // Sem logo própria da empresa, a marca do sistema: símbolo, divisória e nome do iA.Fest, centralizados na vertical.
    return logo ? <img className={styles.companyLogo} src={logo} alt="Logo da empresa" onError={()=>setLogo(null)} /> : <span className={styles.marcaSistema}><img className={styles.marcaSimbolo} src="/assets/iafest/simbolo-painel.png" alt="" aria-hidden="true" width={160} height={183} /><span className={styles.marcaDivisoria} aria-hidden="true" /><img className={styles.marcaNome} src="/assets/iafest/logotipo-painel.png" alt="iA.Fest" width={360} height={99} /></span>;
}
