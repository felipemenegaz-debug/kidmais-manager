import PainelResumo from '@/components/desenvolvedor/PainelResumo';
import { exigirDesenvolvedorNaPagina } from '@/lib/desenvolvedor/pagina';

export const dynamic = 'force-dynamic';

export default async function Page() {
    await exigirDesenvolvedorNaPagina('/desenvolvedor');
    return <PainelResumo />;
}
