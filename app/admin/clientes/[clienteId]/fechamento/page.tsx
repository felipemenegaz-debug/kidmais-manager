import FechamentoAdminWizard from '@/components/admin/FechamentoAdminWizard';

export default async function Page({ params, searchParams }: { params: Promise<{ clienteId: string }>; searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
    const { clienteId } = await params;
    // Preparação do Kidmais: só a referência opaca; o servidor revalida tudo ao abrir e ao enviar.
    const rascunho = (await searchParams).rascunho;
    return <FechamentoAdminWizard key={`${clienteId}:${typeof rascunho === 'string' ? rascunho : ''}`} clienteId={clienteId} rascunho={typeof rascunho === 'string' ? rascunho : undefined} />;
}
