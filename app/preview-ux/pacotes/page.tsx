import { notFound } from 'next/navigation';
import PreviewUx from '@/components/admin/PreviewUx';

export default async function Page({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  if (process.env.KIDMAIS_PREVIEW_UX !== '1') notFound();
  const params = await searchParams;
  return <PreviewUx tela="pacotes" estado={params.estado} />;
}
