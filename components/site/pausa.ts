/** Estado único da pausa das animações do site de venda (canvas, bordas, halo, botões e pseudo-elementos). */
export const EVENTO_PAUSA = 'iafest:pausa';
export const RAIZ_SITE = '[data-site-venda]';
export function pausaAtual(): boolean | undefined {
    const valor = typeof document === 'undefined' ? null : document.querySelector(RAIZ_SITE)?.getAttribute('data-pausado');
    return valor === 'true' ? true : valor === 'false' ? false : undefined;
}
export function aplicarPausa(pausado: boolean) {
    document.querySelector(RAIZ_SITE)?.setAttribute('data-pausado', String(pausado));
    window.dispatchEvent(new CustomEvent(EVENTO_PAUSA, { detail: pausado }));
}
