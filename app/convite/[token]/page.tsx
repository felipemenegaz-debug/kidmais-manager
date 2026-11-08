import type { Metadata } from 'next';
import ConvitePublico from '@/components/convites/ConvitePublico';
import { publico } from '@/lib/convites/service';
const base: Metadata = { title: 'Você está convidado!', description: 'Um momento especial espera por você.', robots: { index: false, follow: false }, referrer: 'no-referrer' };
const ICONE_NEUTRO: Metadata['icons'] = { icon: [{ url: '/icone-orcamento.svg', type: 'image/svg+xml' }] };
type Parametros = { params: Promise<{ token: string }> };
/** A própria Kidmais mantém o ícone da raiz; outro buffet, convite indisponível ou dúvida levam o ícone neutro. */
export async function generateMetadata({ params }: Parametros): Promise<Metadata> {
  const { token } = await params;
  try { if ((await publico(token)).marcaKidmais) return base; } catch { /* Sem prova da empresa: neutro. */ }
  return { ...base, icons: ICONE_NEUTRO };
}
export default async function Page({ params }: Parametros) {
  const { token } = await params; return <ConvitePublico token={token} />;
}
