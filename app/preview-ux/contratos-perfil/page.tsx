import { notFound } from 'next/navigation';
import AdminShell from '@/components/admin/AdminShell';
import ContratoAdmin from '@/components/admin/ContratoAdmin';
import FechamentoAdminWizard from '@/components/admin/FechamentoAdminWizard';
import PerfilEmpresa from '@/components/admin/PerfilEmpresa';
import { fonteAdmin } from '@/components/admin/fonte';

/** Superfície isolada para testes de navegador: o runner intercepta todas as APIs. */
export default async function Page({ searchParams }: { searchParams: Promise<{ tela?: string }> }) {
    if (process.env.KIDMAIS_PREVIEW_UX !== '1') notFound();
    const { tela } = await searchParams;
    const caminho = tela === 'perfil' ? '/admin/configuracoes/perfil-empresa' : '/admin/contratos';
    return <div className={fonteAdmin.variable}><AdminShell vitrine={{ nome: 'Revisão visual', caminho }}>
        {tela === 'perfil' ? <PerfilEmpresa /> : tela === 'revisao' ? <FechamentoAdminWizard clienteId="00000000-0000-4000-8000-000000000001" /> : <ContratoAdmin />}
    </AdminShell></div>;
}
