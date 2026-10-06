import Link from 'next/link';
import type { Metadata } from 'next';
import admin from '@/components/admin/admin.module.css';
import { fonteAdmin } from '@/components/admin/fonte';
import tokens from '@/components/admin/tokens.module.css';

export const metadata: Metadata = { title: 'Página não encontrada — Kidmais Manager', robots: { index: false, follow: false } };

/**
 * 404 único da aplicação. Vale tanto para endereços inexistentes quanto para áreas restritas de quem não tem a
 * autorização: a mensagem é a mesma e não revela o que existe. Oferece saídas seguras — o início do Admin (que leva
 * ao login se não houver sessão), o perfil e o login.
 */
export default function NotFound() {
    return <div className={`${fonteAdmin.variable} ${tokens.tema}`} style={{ minHeight: '100svh' }}>
        <main className={`${admin.page} ${admin.login}`}>
            <h1>Kidmais Manager</h1>
            <h2>Página não encontrada</h2>
            <p>Este endereço não existe ou não está disponível para a sua conta.</p>
            <nav aria-label="Saídas seguras">
                <p><Link href="/admin/dashboard">Ir para o início</Link></p>
                <p><Link href="/admin/perfil">Meu perfil e senha</Link></p>
                <p><Link href="/admin/login">Entrar com outra conta</Link></p>
            </nav>
        </main>
    </div>;
}
