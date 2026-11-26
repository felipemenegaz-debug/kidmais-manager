'use client';
import { useState, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { avisoDoDocumento, naRotaInicial, registrarRota } from '@/components/rota-do-documento';

/**
 * Mostra o aviso deixado antes de uma navegação de descarte (empresa/sessão mudou durante uma operação): o que
 * aconteceu com a operação — nada enviado, recusada, concluída ou resultado incerto. Lido uma vez por documento (components/rota-do-documento.ts).
 * 25/11/2026: o aviso fala da tela que a carga abriu. Aparece só enquanto a aba está na rota inicial do documento e
 * some de vez na primeira troca de rota da navegação interna, porque as telas seguintes trazem dados novos e corretos.
 * A rota inicial e a saída vêm do ObservadorDeRota no layout raiz, que vê também as telas sem esta faixa (Astra r2).
 */
const semInscricao = () => () => undefined;

export default function AvisoContexto({ className }: { className?: string }) {
    const aviso = useSyncExternalStore(semInscricao, avisoDoDocumento, () => null);
    const rota = usePathname();
    const [fechado, setFechado] = useState(false);
    // Só no cliente (no servidor o aviso é sempre null). Idempotente, como o registro do ObservadorDeRota.
    if (aviso) registrarRota(rota);
    const visivel = aviso && naRotaInicial(rota) ? aviso : null;
    if (!visivel || fechado)
        return null;
    return <div role="alert" data-aviso-contexto className={className} style={{ margin: '16px 32px 0', padding: '14px 16px', borderRadius: 14, border: '1px solid color-mix(in srgb, #FF7A3D 35%, transparent)', background: 'color-mix(in srgb, #FF7A3D 8%, transparent)', color: 'var(--main-text, inherit)', fontSize: 13, display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <span>{visivel}</span>
        <button type="button" onClick={() => setFechado(true)} aria-label="Fechar aviso" style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer', minHeight: 24 }}>×</button>
    </div>;
}
