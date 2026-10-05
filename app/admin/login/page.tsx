'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from '@/components/admin/admin.module.css';
import AvisoContexto from '@/components/admin/AvisoContexto';
/** Retorno após o login: só caminhos internos do Admin, do perfil ou do painel do desenvolvedor. */
function destinoSeguro() {
    const voltar = new URLSearchParams(window.location.search).get('voltar') ?? '';
    return /^\/(admin|desenvolvedor)(\/[A-Za-z0-9_\-/]*)?$/.test(voltar) && !voltar.includes('//') && !voltar.startsWith('/admin/login') ? voltar : '/admin/contratos';
}
export default function LoginAdmin() {
    const router = useRouter();
    const [error, setError] = useState(''), [busy, setBusy] = useState(false);
    // Senha oculta por padrão; o botão só alterna a exibição (type="button": não envia o formulário).
    const [mostrarSenha, setMostrarSenha] = useState(false);
    return <main className={`${styles.page} ${styles.login}`}><h1>Kidmais Manager</h1><h2>Acesso administrativo</h2><AvisoContexto />
 <form onSubmit={async (event) => {
            event.preventDefault();
            setMostrarSenha(false);
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
 <div style={{ marginBottom: 16 }}>
  <label htmlFor="senha-admin" style={{ display: 'block' }}>Senha</label>
  <input id="senha-admin" name="senha" type={mostrarSenha ? 'text' : 'password'} autoComplete="current-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} required style={{ display: 'block', width: '100%', padding: 10 }}/>
  <button type="button" aria-controls="senha-admin" onClick={() => setMostrarSenha(v => !v)} style={{ marginTop: 8 }}>{mostrarSenha ? 'Ocultar senha' : 'Mostrar senha'}</button>
 </div>
 <button disabled={busy} type="submit">{busy ? 'Entrando…' : 'Entrar'}</button><p role="alert">{error}</p></form>
 <p><a href="/acesso/recuperar">Esqueci minha senha</a></p>
 <p>Contas são criadas pelo operador autorizado ou por convite. Não há cadastro público.</p></main>;
}
