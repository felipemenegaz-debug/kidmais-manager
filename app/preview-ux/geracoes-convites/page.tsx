import { notFound } from 'next/navigation';
import DesenvolvedorShell from '@/components/desenvolvedor/DesenvolvedorShell';
import GeracoesConvites from '@/components/desenvolvedor/GeracoesConvites';
import { fonteAdmin } from '@/components/admin/fonte';

export const dynamic = 'force-dynamic';

/** Vitrine da fila do operador de gerações de convites. Sem dados embutidos: a API é simulada pelo roteiro de navegador. Só com KIDMAIS_PREVIEW_UX=1. */
export default function Page() {
    if (process.env.KIDMAIS_PREVIEW_UX !== '1') notFound();
    return <div className={fonteAdmin.variable}>
        <DesenvolvedorShell nome="Operador da plataforma"><GeracoesConvites /></DesenvolvedorShell>
    </div>;
}
