import type { Metadata } from 'next';
import ConviteEditor from '@/components/convites/ConviteEditor';
// O token fica no fragmento da URL: o servidor não sabe de qual buffet é o convite, então o HTML é neutro para todos.
export const metadata: Metadata = { title: 'Crie seu convite', description: 'Monte o convite da festa.', icons: { icon: [{ url: '/icone-orcamento.svg', type: 'image/svg+xml' }] }, robots: { index: false, follow: false }, referrer: 'no-referrer' };
export default function Page() { return <ConviteEditor />; }
