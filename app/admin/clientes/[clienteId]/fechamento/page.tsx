import FechamentoAdminWizard from '@/components/admin/FechamentoAdminWizard';

export default async function Page({ params }: { params: Promise<{ clienteId: string }> }) {
    const { clienteId } = await params;
    return <FechamentoAdminWizard key={clienteId} clienteId={clienteId} />;
}
