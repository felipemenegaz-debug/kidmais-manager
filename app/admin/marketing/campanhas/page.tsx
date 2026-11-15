import MarketingCampanhas from '@/components/admin/marketing/MarketingCampanhas';
import { dataInicialDaCampanha } from '@/lib/marketing/campanhas-ui';

export default async function Page({ searchParams }: { searchParams: Promise<{ data?: string | string[] }> }) {
  const dataInicial = dataInicialDaCampanha((await searchParams).data);
  return <MarketingCampanhas key={dataInicial ?? 'lista'} dataInicial={dataInicial} />;
}
