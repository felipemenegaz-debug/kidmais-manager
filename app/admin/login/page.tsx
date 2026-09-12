'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from '@/components/admin/admin.module.css';
export default function LoginAdmin() {
    const router = useRouter();
    const [error, setError] = useState(''), [busy, setBusy] = useState(false);
    return <main className={`${styles.page} ${styles.login}`}><h1>Kidmais Manager</h1><h2>Acesso administrativo</h2>
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
                router.replace('/admin/contratos');
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
 <label style={{ display: 'block', marginBottom: 16 }}>Senha<input name="senha" type="password" autoComplete="current-password" required style={{ display: 'block', width: '100%', padding: 10 }}/></label>
 <button disabled={busy} type="submit">{busy ? 'Entrando…' : 'Entrar'}</button><p role="alert">{error}</p></form>
 <p>Contas são criadas pelo operador autorizado. Não há cadastro público.</p></main>;
}
