'use client';
import { lerAvisoDeContexto } from '@/lib/http/contexto-empresa-cliente';

/**
 * Aviso de contexto e rota inicial deste documento (carga completa), e se a navegação interna já saiu dela (25/11/2026,
 * faixa de aviso de contexto). Alimentado pelo ObservadorDeRota no layout raiz, que renderiza em TODA rota antes das
 * páginas, inclusive as que não mostram a faixa: o aviso de uma carga vale só para a tela que ela abriu (Astra r2, P2) e é
 * consumido do armazenamento já na primeira renderização cliente do documento, com ou sem faixa, para não sobrar para um
 * documento seguinte (Astra r3, P2). Só cresce: depois de sair, voltar à rota inicial não a "reabre". Registrar a mesma
 * rota de novo (Strict Mode, nova renderização) não muda nada.
 */
let aviso: string | null | undefined;
let inicial: string | null = null;
let saiu = false;

/** Lê e remove o aviso guardado uma vez por documento; as chamadas seguintes devolvem o mesmo valor. Só no cliente. */
export function avisoDoDocumento() {
    if (aviso === undefined) aviso = lerAvisoDeContexto();
    return aviso;
}

export function registrarRota(rota: string) {
    if (inicial === null) inicial = rota;
    else if (rota !== inicial) saiu = true;
}

/** true enquanto a aba está na rota que a carga abriu e nunca saiu dela. */
export function naRotaInicial(rota: string) {
    return !saiu && inicial === rota;
}
