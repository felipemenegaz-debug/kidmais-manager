'use client';
import { usePathname } from 'next/navigation';
import { avisoDoDocumento, registrarRota } from '@/components/rota-do-documento';

// Layout raiz: renderiza em todo documento e em toda troca de rota, antes das páginas (irmão anterior a {children}). O
// registro é feito na renderização, não num efeito, porque os efeitos dos filhos rodam antes e a faixa de aviso precisa
// saber da rota já na primeira pintura. É idempotente. Também consome o aviso de contexto do documento, mesmo em telas
// sem a faixa (Astra r3, P2). No servidor não faz nada, porque o estado do módulo seria compartilhado entre requisições.
export default function ObservadorDeRota() {
    const rota = usePathname();
    if (typeof window !== 'undefined') {
        avisoDoDocumento();
        registrarRota(rota);
    }
    return null;
}
