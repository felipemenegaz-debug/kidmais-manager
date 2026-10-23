import { notFound } from 'next/navigation';
import PreviewAgendaUx from '@/components/admin/PreviewAgendaUx';

export default async function Page({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  if (process.env.KIDMAIS_PREVIEW_UX !== '1') notFound();
  const params = await searchParams;
  return <PreviewAgendaUx estado={params.estado} />;
}
