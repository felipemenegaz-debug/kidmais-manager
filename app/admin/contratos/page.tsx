import { Suspense } from 'react';
import ContratoAdmin from '@/components/admin/ContratoAdmin';
// ContratoAdmin lê contratoId/versaoId com useSearchParams: o limite de Suspense mantém o restante pré-renderizável.
export default function Page() { return <Suspense fallback={<p role="status">Carregando contratos…</p>}><ContratoAdmin /></Suspense>; }
