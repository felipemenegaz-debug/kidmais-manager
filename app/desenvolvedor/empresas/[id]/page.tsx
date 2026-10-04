import EmpresaFicha from '@/components/desenvolvedor/EmpresaFicha';
import { exigirDesenvolvedorNaPagina } from '@/lib/desenvolvedor/pagina';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    await exigirDesenvolvedorNaPagina(`/desenvolvedor/empresas/${encodeURIComponent(id)}`);
    return <EmpresaFicha id={id} />;
}
