import Provisionar from '@/components/desenvolvedor/Provisionar';
import { exigirDesenvolvedorNaPagina } from '@/lib/desenvolvedor/pagina';

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<{ interessada?: string }> }) {
    await exigirDesenvolvedorNaPagina('/desenvolvedor/empresas/provisionar');
    const { interessada } = await searchParams;
    return <Provisionar interessadaId={typeof interessada === 'string' && /^[0-9a-f-]{36}$/i.test(interessada) ? interessada : null} />;
}
