import { Suspense } from 'react';
import Atividade from '@/components/desenvolvedor/Atividade';
import { exigirDesenvolvedorNaPagina } from '@/lib/desenvolvedor/pagina';

export const dynamic = 'force-dynamic';

export default async function Page() {
    await exigirDesenvolvedorNaPagina('/desenvolvedor/atividade');
    return <Suspense fallback={<p style={{ padding: 32 }}>Carregando…</p>}><Atividade /></Suspense>;
}
