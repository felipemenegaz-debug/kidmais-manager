import type { Metadata } from 'next';
import { fonteAdmin } from '@/components/admin/fonte';
import AvisoEndereco from '@/components/enderecos/AvisoEndereco';
import tokens from '@/components/admin/tokens.module.css';

export const metadata: Metadata = { title: 'Cadastro — iA.Fest', robots: { index: false, follow: false }, icons: { icon: [{ url: '/assets/iafest/simbolo-painel.png', type: 'image/png' }] } };

/** Cadastro público: pedido de conta e confirmação (sem sessão) e cadastro da empresa (com a sessão recém-aberta). */
export default function CadastroLayout({ children }: { children: React.ReactNode }) {
    return <div className={`${fonteAdmin.variable} ${tokens.tema}`} style={{ minHeight: '100svh' }}><AvisoEndereco />{children}</div>;
}
