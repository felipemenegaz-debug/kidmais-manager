import SalaoApresentacao from '@/components/admin/SalaoApresentacao';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SalaoApresentacao salaoId={id} />;
}
