import { Suspense } from 'react';
import MarketingSitePrevia from '@/components/admin/marketing/MarketingSitePrevia';

/** Prévia do rascunho (sessão administrativa; /admin é noindex). */
export default function Page() {
  return <Suspense fallback={<p role="status">Carregando prévia…</p>}><MarketingSitePrevia /></Suspense>;
}
