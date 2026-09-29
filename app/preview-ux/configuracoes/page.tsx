import { notFound } from 'next/navigation';
import PreviewConfiguracoes, { type TelaConfiguracao } from '@/components/admin/PreviewConfiguracoes';

const TELAS: TelaConfiguracao[] = ['hub', 'perfil', 'acessos', 'whatsapp', 'pdf'];

export default async function Page({ searchParams }: { searchParams: Promise<{ tela?: string }> }) {
  if (process.env.KIDMAIS_PREVIEW_UX !== '1') notFound();
  const { tela } = await searchParams;
  return <PreviewConfiguracoes tela={TELAS.includes(tela as TelaConfiguracao) ? tela as TelaConfiguracao : 'hub'} />;
}
