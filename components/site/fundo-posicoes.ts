export type Area = { left: number; top: number; right: number; bottom: number };
export type Posicao = { x: number; y: number; raio: number };

/** Reserva também a amplitude da flutuação, para o desenho não invadir conteúdo. */
export function posicaoLivre(p: Posicao, largura: number, altura: number, areas: Area[], usadas: Posicao[]) {
    const { x, y, raio: r } = p;
    return x - r >= 10 && x + r <= largura - 10 && y - r >= 10 && y + r <= altura - 10
        && !areas.some(a => x + r > a.left - 8 && x - r < a.right + 8 && y + r > a.top - 8 && y - r < a.bottom + 8)
        && !usadas.some(a => Math.hypot(x - a.x, y - a.y) < r + a.raio + 115);
}

export function localizarEspaco(preferida: Posicao, largura: number, altura: number, areas: Area[], usadas: Posicao[]) {
    if (posicaoLivre(preferida, largura, altura, areas, usadas)) return preferida;
    let melhor: Posicao | null = null;
    let distancia = Infinity;
    for (let y = preferida.raio + 15; y < altura - preferida.raio; y += 58) {
        for (let x = preferida.raio + 15; x < largura - preferida.raio; x += 62) {
            const d = Math.hypot(x - preferida.x, y - preferida.y);
            const p = { x, y, raio: preferida.raio };
            if (d < distancia && posicaoLivre(p, largura, altura, areas, usadas)) { melhor = p; distancia = d; }
        }
    }
    return melhor;
}
