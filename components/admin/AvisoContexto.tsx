'use client';
import { useState, useSyncExternalStore } from 'react';
import { lerAvisoDeContexto } from '@/lib/http/contexto-empresa-cliente';

/**
 * Mostra o aviso deixado antes de uma navegação de descarte (empresa/sessão mudou durante uma operação): o que
 * aconteceu com a operação — nada enviado, recusada, concluída ou resultado incerto. Lido uma vez por carga.
 */
let lido: string | null | undefined;
const semInscricao = () => () => undefined;
function lerUmaVez() {
    if (lido === undefined)
        lido = lerAvisoDeContexto();
    return lido;
}

export default function AvisoContexto({ className }: { className?: string }) {
    const aviso = useSyncExternalStore(semInscricao, lerUmaVez, () => null);
    const [fechado, setFechado] = useState(false);
    if (!aviso || fechado)
        return null;
    return <div role="alert" data-aviso-contexto className={className} style={{ margin: '16px 32px 0', padding: '14px 16px', borderRadius: 14, border: '1px solid color-mix(in srgb, #FF7A3D 35%, transparent)', background: 'color-mix(in srgb, #FF7A3D 8%, transparent)', color: 'var(--main-text, inherit)', fontSize: 13, display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <span>{aviso}</span>
        <button type="button" onClick={() => setFechado(true)} aria-label="Fechar aviso" style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer', minHeight: 24 }}>×</button>
    </div>;
}
