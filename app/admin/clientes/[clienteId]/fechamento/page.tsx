import FechamentoAdminWizard from '@/components/admin/FechamentoAdminWizard';

export default async function Page({ params, searchParams }: { params: Promise<{ clienteId: string }>; searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
    const { clienteId } = await params;
    // Preparação do Kidmais: só a referência opaca; o servidor revalida tudo ao abrir e ao enviar.
    const q = await searchParams;
    const rascunho = q.rascunho;
    const data = typeof q.data === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q.data) ? q.data : "";
    const convidados = typeof q.convidados === "string" && /^\d+$/.test(q.convidados) && Number(q.convidados)>0 && Number(q.convidados)<=5000 ? Number(q.convidados) : undefined;
    return <FechamentoAdminWizard key={`${clienteId}:${typeof rascunho === 'string' ? rascunho : ''}`} clienteId={clienteId} pedido={{data,convidados}} rascunho={typeof rascunho === 'string' ? rascunho : undefined} />;
}
