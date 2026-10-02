import { redirect } from 'next/navigation';

/** O contrato importado passou a ser consultado em Contratos; este endereço só redireciona. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/admin/contratos?importacaoId=${encodeURIComponent(id)}`);
}
