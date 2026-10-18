import GeracoesConvites from '@/components/desenvolvedor/GeracoesConvites';
import { exigirDesenvolvedorNaPagina } from '@/lib/desenvolvedor/pagina';

export const dynamic = 'force-dynamic';

export default async function Page() {
    await exigirDesenvolvedorNaPagina('/desenvolvedor/convites');
    return <GeracoesConvites />;
}
