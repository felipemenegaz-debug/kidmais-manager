import type { Metadata } from 'next';
import ConsentimentoAssistente from '@/components/admin/ConsentimentoAssistente';

export const dynamic = 'force-dynamic';
/** O pedido opaco está na URL: sem Referer, nem para a mesma origem (revisão do Astra de 28/10/2026). */
export const metadata: Metadata = { referrer: 'no-referrer' };

/** Destino do /api/mcp/oauth/authorize. O pedido é opaco; a tela lê os detalhes pela API autenticada. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const p = (await searchParams).pedido;
    return <ConsentimentoAssistente pedidoId={typeof p === 'string' ? p : ''} />;
}
