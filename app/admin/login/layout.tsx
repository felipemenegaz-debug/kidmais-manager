import type { Metadata } from 'next';

/** O login pode carregar `voltar` com o pedido do consentimento MCP: sem Referer (revisão do Astra de 28/10/2026). */
export const metadata: Metadata = { referrer: 'no-referrer' };

export default function LayoutLogin({ children }: { children: React.ReactNode }) {
    return children;
}
