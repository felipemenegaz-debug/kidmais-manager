'use client';
import { useState } from 'react';
import Link from 'next/link';
import admin from '@/components/admin/admin.module.css';
import { postarPublico } from '@/components/acesso/token';

/** Pedido público de recuperação. A resposta é a mesma para qualquer e-mail (não revela se a conta existe). */
export default function RecuperarSenha() {
    const [email, setEmail] = useState('');
    const [mensagem, setMensagem] = useState('');
    const [erro, setErro] = useState('');
    const [ocupado, setOcupado] = useState(false);
    return <main className={`${admin.page} ${admin.login}`}>
        <h1>Kidmais Manager</h1>
        <h2>Recuperar acesso</h2>
        {mensagem ? <>
            <p role="status">{mensagem}</p>
            <p>O link vale por 30 minutos e só pode ser usado uma vez. Se não chegar, confira o spam ou peça de novo daqui a alguns minutos.</p>
            <p><Link href="/admin/login">Voltar ao login</Link></p>
        </> : <form onSubmit={async (e) => {
            e.preventDefault();
            setOcupado(true);
            setErro('');
            const r = await postarPublico<{ mensagem: string }>('/api/acesso/recuperacao', { email: email.trim() });
            setOcupado(false);
            if (r.ok) setMensagem(r.data.mensagem);
            else setErro(r.erro);
        }}>
            <p>Informe o e-mail da sua conta. Se ela existir e estiver ativa, enviaremos um link para você definir uma nova senha.</p>
            <label>E-mail<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} /></label>
            <p role="alert">{erro}</p>
            <button type="submit" disabled={ocupado || !email.trim()}>{ocupado ? 'Enviando…' : 'Enviar link'}</button>
            <p><Link href="/admin/login">Voltar ao login</Link></p>
        </form>}
    </main>;
}
