import { Suspense } from 'react';
import RetornosPagina from '@/components/admin/satisfacao/RetornosPagina';

export default function Page() {
  return <Suspense fallback={null}><RetornosPagina /></Suspense>;
}
