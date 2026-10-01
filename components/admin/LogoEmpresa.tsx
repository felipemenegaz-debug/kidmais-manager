'use client';
/* eslint-disable @next/next/no-img-element -- Logo interna em data URL validada pelo servidor. */
import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import { AdminIcon } from './AdminIcon';
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
    return logo ? <img className={styles.companyLogo} src={logo} alt="Logo da empresa" onError={()=>setLogo(null)} /> : <><span className={styles.brandMark}><AdminIcon name="cake" size={18} /></span><span className={styles.brandText}>Kidmais<span>Admin</span></span></>;
}
