'use client';
import { useEffect } from 'react';
import { referenciaDoErro } from '@/components/erro/referencia';

/** Falha no layout raiz: substitui o documento inteiro, por isso tem html/body e estilos próprios. Neutra como app/error. */
export default function ErroGlobal({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
    useEffect(() => { console.error(error); }, [error]);
    const referencia = referenciaDoErro(error);
    return <html lang="pt-BR">
        <body style={{ margin: 0, background: '#0b0f1e', color: '#eef0ff', fontFamily: 'system-ui, sans-serif', lineHeight: 1.6 }}>
            <title>Erro inesperado</title>
            <main style={{ maxWidth: 520, margin: '80px auto', padding: '0 16px' }} data-erro-global>
                <h1 style={{ fontSize: 22 }}>Não foi possível carregar esta página</h1>
                <p role="alert">Algo deu errado. Tente de novo em instantes.</p>
                {referencia && <p data-referencia>Código de referência: <code>{referencia}</code></p>}
                <p><button type="button" onClick={() => retry()}>Tentar novamente</button></p>
            </main>
        </body>
    </html>;
}
