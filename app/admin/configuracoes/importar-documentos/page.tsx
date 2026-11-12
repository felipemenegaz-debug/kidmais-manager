import ImportarDocumentos, { documentoDaUrl } from '@/components/admin/ImportarDocumentos';

export default async function Page({ searchParams }: { searchParams: Promise<{ documento?: string | string[] }> }) {
  const { documento } = await searchParams;
  return <ImportarDocumentos documento={documentoDaUrl(documento)} />;
}
