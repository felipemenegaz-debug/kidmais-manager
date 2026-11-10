import type { Metadata } from 'next';
import { fonteAdmin } from '@/components/admin/fonte';
import AvisoEndereco from '@/components/enderecos/AvisoEndereco';
import tokens from '@/components/admin/tokens.module.css';

export const metadata: Metadata = { title: 'Acesso — iA.Fest', robots: { index: false, follow: false }, icons: { icon: [{ url: '/assets/iafest/simbolo-painel.png', type: 'image/png' }] } };

/** Páginas públicas de acesso (convite, recuperação e redefinição de senha). Nenhuma depende de sessão. */
export default function AcessoLayout({ children }: { children: React.ReactNode }) {
    return <div className={`${fonteAdmin.variable} ${tokens.tema}`} style={{ minHeight: '100svh' }}><AvisoEndereco />{children}</div>;
}
