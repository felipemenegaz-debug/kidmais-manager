'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from '@/components/admin/admin.module.css';
import AvisoContexto from '@/components/admin/AvisoContexto';
/** Retorno após o login: só caminhos internos do Admin, do perfil ou do painel do desenvolvedor. */
function destinoSeguro() {
    const voltar = new URLSearchParams(window.location.search).get('voltar') ?? '';
    return /^\/(admin|desenvolvedor)(\/[A-Za-z0-9_\-/]*)?$/.test(voltar) && !voltar.includes('//') && !voltar.startsWith('/admin/login') ? voltar : '/admin/dashboard';
}
export default function LoginAdmin() {
    const router = useRouter();
    const [mostrarSenha, setMostrarSenha] = useState(false);
    const [error, setError] = useState(''), [busy, setBusy] = useState(false);
    return <main className={`${styles.page} ${styles.login}`}><h1>Kidmais Manager</h1><h2>Acesso administrativo</h2><AvisoContexto />
 <form onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            const data = new FormData(event.currentTarget);
            try {
                const start = await fetch('/api/admin/autenticacao', { cache: 'no-store' });
                const initial = await start.json();
                if (!initial.ok)
                    throw Error(initial.erro);
                const res = await fetch('/api/admin/autenticacao', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': initial.data.csrf }, body: JSON.stringify({ acao: 'login', email: data.get('email'), senha: data.get('senha') }) });
                const body = await res.json();
                if (!body.ok)
                    throw Error(body.erro);
                router.replace(destinoSeguro());
                router.refresh();
            }
            catch (e) {
                setError(e instanceof Error ? e.message : 'Não foi possível entrar.');
            }
            finally {
                setBusy(false);
            }
        }}>
 <label style={{ display: 'block', marginBottom: 16 }}>Email<input name="email" type="email" autoComplete="username" required style={{ display: 'block', width: '100%', padding: 10 }}/></label>
 <label htmlFor="senha-login">Senha</label><div style={{ display: 'flex', gap: 8, marginBottom: 16 }}><input id="senha-login" name="senha" type={mostrarSenha ? 'text' : 'password'} autoComplete="current-password" required style={{ flex: 1, minWidth: 0, padding: 10 }}/><button type="button" aria-controls="senha-login" aria-pressed={mostrarSenha} aria-label={mostrarSenha ? 'Ocultar senha' : 'Mostrar senha'} onClick={() => setMostrarSenha(!mostrarSenha)} style={{ padding: '6px 10px', fontSize: 12 }}>{mostrarSenha ? 'Ocultar' : 'Mostrar'}</button></div>
 <button disabled={busy} type="submit">{busy ? 'Entrando…' : 'Entrar'}</button><p role="alert">{error}</p></form>
 <p><a href="/acesso/recuperar">Esqueci minha senha</a></p>
 <p>Contas são criadas pelo operador autorizado ou por convite. Não há cadastro público.</p></main>;
}
