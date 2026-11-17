'use client';
/**
 * Pausa única das animações (canvas do fundo, bordas, halo, botões e pseudo-elementos), usada pelo site iA.Fest e pela
 * área "Minha festa". Arquivo próprio para a área não carregar os interativos do site; `interativos.tsx` reexporta com
 * as classes do site. As classes vêm de quem usa: aqui não há CSS, e o estado vai para `[data-site-venda]` (pausa.ts).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { aplicarPausa } from './pausa';

export const MOVIMENTO_REDUZIDO = '(prefers-reduced-motion: reduce)';

// Conta cada mudança da preferência do sistema: uma escolha feita antes de qualquer mudança deixa de valer, mesmo que
// a preferência volte ao valor de antes (reduce → no-preference → reduce volta a pausar).
let mudancas = 0;
function assinarMovimento(aviso: () => void) {
    const consulta = matchMedia(MOVIMENTO_REDUZIDO);
    const aoMudar = () => { mudancas += 1; aviso(); };
    consulta.addEventListener('change', aoMudar);
    return () => consulta.removeEventListener('change', aoMudar);
}
const lerMovimento = () => (matchMedia(MOVIMENTO_REDUZIDO).matches ? 'r' : 'n') + mudancas;

/** Um botão para canvas, bordas, halo, botões e pseudo-elementos. Começa pela preferência do sistema e a acompanha. */
export function PausaGlobal({ classe, classeTexto }: { classe?: string; classeTexto?: string }) {
    const movimento = useSyncExternalStore(assinarMovimento, lerMovimento, () => 'n0');
    const reduzido = movimento.startsWith('r');
    // A escolha do visitante vale até a próxima mudança da preferência do sistema.
    const [escolha, setEscolha] = useState<{ pausado: boolean; movimento: string } | null>(null);
    const pausado = escolha && escolha.movimento === movimento ? escolha.pausado : reduzido;
    useEffect(() => { aplicarPausa(pausado); }, [pausado]);
    return <button type="button" className={classe} aria-pressed={pausado} onClick={() => setEscolha({ pausado: !pausado, movimento })}>
        <span aria-hidden="true">{pausado ? '▶' : '❚❚'}</span><span className={classeTexto}>Pausar animações</span>
    </button>;
}
