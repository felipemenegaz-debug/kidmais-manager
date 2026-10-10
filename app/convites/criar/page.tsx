import type { Metadata } from 'next';
import ConviteEditor from '@/components/convites/ConviteEditor';
export const metadata: Metadata = { title: 'Crie seu convite | KidMais', robots: { index: false, follow: false }, referrer: 'no-referrer' };
export default function Page() { return <ConviteEditor />; }
