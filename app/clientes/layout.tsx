import AdminShell from '@/components/admin/AdminShell';
import { artigosDaCentral } from '@/lib/suporte/central';
import { carregarCorpusAprovado } from '@/lib/conhecimento/carregar';
import { hojeBrasilia } from '@/lib/financeiro/calculos';
import { fonteAdmin } from '@/components/admin/fonte';
export default function ClientesLayout({ children }: {
    children: React.ReactNode;
}) {
    return <div className={fonteAdmin.variable}><AdminShell artigosAjuda={artigosDaCentral(carregarCorpusAprovado(), hojeBrasilia()).map((a) => ({ id: a.id, ate: a.ate }))}>{children}</AdminShell></div>;
}
