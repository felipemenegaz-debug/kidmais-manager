import { Suspense } from 'react';
import Empresas from '@/components/desenvolvedor/Empresas';
import { exigirDesenvolvedorNaPagina } from '@/lib/desenvolvedor/pagina';

export const dynamic = 'force-dynamic';

export default async function Page() {
    await exigirDesenvolvedorNaPagina('/desenvolvedor/empresas');
    return <Suspense fallback={<p style={{ padding: 32 }}>Carregando…</p>}><Empresas /></Suspense>;
}
