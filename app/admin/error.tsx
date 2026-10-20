'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import admin from '@/components/admin/admin.module.css';
import { ROTA_AJUDA } from '@/lib/suporte/rota';
import { referenciaDoErro } from '@/components/erro/referencia';

/** Erro inesperado numa tela do Admin: o menu continua (o layout fica fora desta fronteira) e há saída para o suporte. */
export default function ErroAdmin({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
    useEffect(() => { console.error(error); }, [error]);
    const referencia = referenciaDoErro(error);
    return <main className={admin.page} data-erro-admin>
        <h1>Não foi possível abrir esta tela</h1>
        <p role="alert">Algo deu errado do nosso lado. Seus dados não foram alterados por esta falha.</p>
        {referencia && <p data-referencia>Código de referência: <code>{referencia}</code></p>}
        <p><button type="button" onClick={() => retry()}>Tentar novamente</button></p>
        <p>Se continuar, <Link href={ROTA_AJUDA}>fale com o suporte</Link>{referencia ? ' e informe o código acima' : ''}.</p>
    </main>;
}
