'use client';
import { useEffect } from 'react';
import { referenciaDoErro } from '@/components/erro/referencia';

/**
 * Erro inesperado fora do Admin. Neutro de propósito: estas páginas incluem as de clientes de outras empresas
 * (contrato, convite, /b/<código>, sites públicos), então não leva marca nem contato da Kidmais.
 */
export default function Erro({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
    useEffect(() => { console.error(error); }, [error]);
    const referencia = referenciaDoErro(error);
    return <main style={{ maxWidth: 520, margin: '80px auto', padding: '0 16px', fontFamily: 'system-ui, sans-serif', lineHeight: 1.6 }} data-erro>
        <h1 style={{ fontSize: 22 }}>Não foi possível carregar esta página</h1>
        <p role="alert">Algo deu errado. Tente de novo em instantes.</p>
        {referencia && <p data-referencia>Código de referência: <code>{referencia}</code></p>}
        <p><button type="button" onClick={() => retry()}>Tentar novamente</button></p>
    </main>;
}
