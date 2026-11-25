'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { lerAvisoDeContexto } from '@/lib/http/contexto-empresa-cliente';

/**
 * Mostra o aviso deixado antes de uma navegação de descarte (empresa/sessão mudou durante uma operação): o que
 * aconteceu com a operação — nada enviado, recusada, concluída ou resultado incerto. Lido uma vez por carga.
 * 25/11/2026: o aviso fala da tela que a carga abriu. Ele fica preso à primeira rota em que apareceu e some de vez na
 * próxima troca de rota da navegação interna, porque as telas seguintes trazem dados novos e corretos.
 */
let lido: string | null | undefined;
let rotaDoAviso: string | null = null;
let encerramento: ReturnType<typeof setTimeout> | null = null;
const semInscricao = () => () => undefined;
function lerUmaVez() {
    if (lido === undefined)
        lido = lerAvisoDeContexto();
    return lido;
}

/** Decide o aviso visível na rota atual: a primeira rota prende o aviso; outra rota o encerra para esta carga. */
export function avisoNaRota(aviso: string | null, rota: string, primeira: string | null) {
    return aviso && (primeira === null || primeira === rota) ? aviso : null;
}

export default function AvisoContexto({ className }: { className?: string }) {
    const aviso = useSyncExternalStore(semInscricao, lerUmaVez, () => null);
    const rota = usePathname();
    const [fechado, setFechado] = useState(false);
    useEffect(() => {
        if (!lido) return;
        if (encerramento !== null) { clearTimeout(encerramento); encerramento = null; }
        if (rotaDoAviso === null) rotaDoAviso = rota;
        else if (rotaDoAviso !== rota) { lido = null; return; }
        // A instância que mostra o aviso saiu da árvore (ex.: tela seguinte sem a faixa): o aviso termina, salvo se outra
        // montagem na mesma rota o retomar logo em seguida, como a repetição de efeitos do Strict Mode (Astra r1, P2).
        return () => { if (encerramento === null) encerramento = setTimeout(() => { encerramento = null; lido = null; }, 0); };
    }, [rota]);
    const visivel = avisoNaRota(aviso, rota, rotaDoAviso);
    if (!visivel || fechado)
        return null;
    return <div role="alert" data-aviso-contexto className={className} style={{ margin: '16px 32px 0', padding: '14px 16px', borderRadius: 14, border: '1px solid color-mix(in srgb, #FF7A3D 35%, transparent)', background: 'color-mix(in srgb, #FF7A3D 8%, transparent)', color: 'var(--main-text, inherit)', fontSize: 13, display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <span>{visivel}</span>
        <button type="button" onClick={() => setFechado(true)} aria-label="Fechar aviso" style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer', minHeight: 24 }}>×</button>
    </div>;
}
