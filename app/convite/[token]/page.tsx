import type { Metadata } from 'next';
import ConvitePublico from '@/components/convites/ConvitePublico';
export const metadata: Metadata = { title: 'Você está convidado!', description: 'Um momento especial espera por você.', robots: { index: false, follow: false }, referrer: 'no-referrer' };
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params; return <ConvitePublico token={token} />;
}
