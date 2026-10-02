import FestaImportada from '@/components/festas/FestaImportada';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FestaImportada importacaoId={id} />;
}
