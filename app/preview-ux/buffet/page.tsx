import { notFound } from 'next/navigation';
import PreviewUx from '@/components/admin/PreviewUx';

export default async function Page({ searchParams }: { searchParams: Promise<{ secao?: string }> }) {
  if (process.env.KIDMAIS_PREVIEW_UX !== '1') notFound();
  const params = await searchParams;
  return <PreviewUx tela="buffet" estado={params.secao} />;
}
