import { Suspense } from 'react';
import Interessadas from '@/components/desenvolvedor/Interessadas';
import { exigirDesenvolvedorNaPagina } from '@/lib/desenvolvedor/pagina';

export const dynamic = 'force-dynamic';

export default async function Page() {
    await exigirDesenvolvedorNaPagina('/desenvolvedor/interessadas');
    return <Suspense fallback={<p style={{ padding: 32 }}>Carregando…</p>}><Interessadas /></Suspense>;
}
