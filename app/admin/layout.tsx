import AdminShell from '@/components/admin/AdminShell';
import { artigosDaCentral } from '@/lib/suporte/central';
import { carregarCorpusAprovado } from '@/lib/conhecimento/carregar';
import { hojeBrasilia } from '@/lib/financeiro/calculos';
import { fonteAdmin } from '@/components/admin/fonte';
import AvisoEndereco from '@/components/enderecos/AvisoEndereco';
export default function AdminLayout({ children }: {
    children: React.ReactNode;
}) { return <div className={fonteAdmin.variable}><AvisoEndereco /><AdminShell artigosAjuda={artigosDaCentral(carregarCorpusAprovado(), hojeBrasilia()).map((a) => ({ id: a.id, ate: a.ate }))}>{children}</AdminShell></div>; }
