import type { Metadata } from 'next';
import { fonteAdmin } from '@/components/admin/fonte';
import DesenvolvedorShell from '@/components/desenvolvedor/DesenvolvedorShell';
import { exigirDesenvolvedorNaPagina } from '@/lib/desenvolvedor/pagina';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Painel do desenvolvedor — Kidmais Manager', robots: { index: false, follow: false } };

/** Área separada da administração das empresas. Cada page.tsx repete a guarda (o layout não roda na navegação do cliente). */
export default async function DesenvolvedorLayout({ children }: { children: React.ReactNode }) {
    const dev = await exigirDesenvolvedorNaPagina('/desenvolvedor');
    return <div className={fonteAdmin.variable}><DesenvolvedorShell nome={dev.nome}>{children}</DesenvolvedorShell></div>;
}
