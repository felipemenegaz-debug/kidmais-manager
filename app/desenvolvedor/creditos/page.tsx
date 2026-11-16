import CreditosOperador from '@/components/desenvolvedor/CreditosOperador';
import { exigirDesenvolvedorNaPagina } from '@/lib/desenvolvedor/pagina';

export const dynamic = 'force-dynamic';

export default async function Page() {
    await exigirDesenvolvedorNaPagina('/desenvolvedor/creditos');
    return <CreditosOperador />;
}
