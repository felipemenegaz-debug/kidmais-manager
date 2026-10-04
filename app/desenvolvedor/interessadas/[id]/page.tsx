import { Suspense } from 'react';
import InteressadaDetalhe from '@/components/desenvolvedor/InteressadaDetalhe';
import { exigirDesenvolvedorNaPagina } from '@/lib/desenvolvedor/pagina';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    await exigirDesenvolvedorNaPagina(`/desenvolvedor/interessadas/${encodeURIComponent(id)}`);
    return <Suspense fallback={<p style={{ padding: 32 }}>Carregando…</p>}><InteressadaDetalhe id={id} /></Suspense>;
}
