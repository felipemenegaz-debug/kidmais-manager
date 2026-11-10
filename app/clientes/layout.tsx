import type { Metadata } from 'next';
import AdminShell from '@/components/admin/AdminShell';
import { artigosDaCentral } from '@/lib/suporte/central';
import { carregarCorpusAprovado } from '@/lib/conhecimento/carregar';
import { hojeBrasilia } from '@/lib/financeiro/calculos';
import { fonteAdmin } from '@/components/admin/fonte';
import AvisoEndereco from '@/components/enderecos/AvisoEndereco';
export const metadata: Metadata = { title: 'iA.Fest', description: 'Gestão de clientes, festas e contratos.', icons: { icon: [{ url: '/assets/iafest/simbolo-painel.png', type: 'image/png' }] } };
export default function ClientesLayout({ children }: {
    children: React.ReactNode;
}) {
    return <div className={fonteAdmin.variable}><AvisoEndereco /><AdminShell artigosAjuda={artigosDaCentral(carregarCorpusAprovado(), hojeBrasilia()).map((a) => ({ id: a.id, ate: a.ate }))}>{children}</AdminShell></div>;
}
