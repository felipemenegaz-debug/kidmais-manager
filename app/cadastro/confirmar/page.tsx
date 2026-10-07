'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import admin from '@/components/admin/admin.module.css';
import { postarPublico, useTokenDoFragmento } from '@/components/acesso/token';

/** Passo 2: abrir o link do e-mail cria a conta e abre a sessão; em seguida, os dados da empresa. */
export default function ConfirmarCadastro() {
    const token = useTokenDoFragmento();
    const [estado, setEstado] = useState<'confirmando' | 'ok' | 'erro'>('confirmando');
    const [erro, setErro] = useState('');
    useEffect(() => {
        if (!token) return;
        let vivo = true;
        postarPublico<{ csrf: string }>('/api/cadastro/confirmar', { token }).then((r) => {
            if (!vivo) return;
            if (r.ok) {
                setEstado('ok');
                window.location.replace('/cadastro/empresa');
            }
            else { setEstado('erro'); setErro(r.erro); }
        });
        return () => { vivo = false; };
    }, [token]);
    const invalido = token === null;
    return <main className={`${admin.page} ${admin.login}`}>
        <h1>Kidmais Manager</h1>
        <h2>Confirmação do e-mail</h2>
        {invalido ? <p role="alert">Este link é inválido. Confira se abriu o link completo do e-mail.</p>
            : estado === 'confirmando' ? <p aria-live="polite">Confirmando…</p>
                : estado === 'ok' ? <p role="status">E-mail confirmado. Abrindo o cadastro da empresa…</p>
                    : <p role="alert">{erro}</p>}
        {(invalido || estado === 'erro') && <p><Link href="/cadastro">Fazer o cadastro novamente</Link> · <Link href="/admin/login">Entrar</Link></p>}
    </main>;
}
