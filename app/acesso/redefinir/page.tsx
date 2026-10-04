'use client';
import { useState } from 'react';
import Link from 'next/link';
import admin from '@/components/admin/admin.module.css';
import { postarPublico, useTokenDoFragmento } from '@/components/acesso/token';

/** Define a nova senha com o link de recuperação (uso único, 30 min). Todas as sessões da conta são encerradas. */
export default function RedefinirSenha() {
    const token = useTokenDoFragmento();
    const [nova, setNova] = useState('');
    const [confirmacao, setConfirmacao] = useState('');
    const [erro, setErro] = useState('');
    const [ocupado, setOcupado] = useState(false);
    const [pronto, setPronto] = useState(false);
    const tamanho = [...nova].length;
    return <main className={`${admin.page} ${admin.login}`}>
        <h1>Kidmais Manager</h1>
        <h2>Definir nova senha</h2>
        {token === undefined && <p aria-live="polite">Carregando…</p>}
        {token === null && <><p role="alert">Este link é inválido. Abra o link completo do e-mail ou peça uma nova recuperação.</p><p><Link href="/acesso/recuperar">Pedir nova recuperação</Link></p></>}
        {pronto ? <>
            <p role="status">Senha definida. Por segurança, todas as sessões abertas da sua conta foram encerradas.</p>
            <p><Link href="/admin/login">Entrar com a nova senha</Link></p>
        </> : token && <form onSubmit={async (e) => {
            e.preventDefault();
            if (tamanho < 8 || tamanho > 128) { setErro('A nova senha deve ter entre 8 e 128 caracteres.'); return; }
            if (nova !== confirmacao) { setErro('A senha e a confirmação não conferem.'); return; }
            setOcupado(true);
            setErro('');
            const r = await postarPublico<{ redefinida: true }>('/api/acesso/redefinir', { token, novaSenha: nova, confirmacao });
            setOcupado(false);
            if (r.ok) { setPronto(true); setNova(''); setConfirmacao(''); }
            else setErro(r.erro);
        }}>
            <label>Nova senha<input type="password" autoComplete="new-password" value={nova} onChange={(e) => setNova(e.target.value)} required maxLength={128} /></label>
            <small>Entre 8 e 128 caracteres.</small>
            <label>Confirme a nova senha<input type="password" autoComplete="new-password" value={confirmacao} onChange={(e) => setConfirmacao(e.target.value)} required maxLength={128} /></label>
            <p role="alert">{erro}</p>
            <button type="submit" disabled={ocupado || !nova || !confirmacao}>{ocupado ? 'Salvando…' : 'Definir nova senha'}</button>
        </form>}
    </main>;
}
