import { temas, type Conteudo } from './domain.ts';

export const visualPadrao = { modo: 'modelo', ajuste: 'conter', x: 50, y: 50 } as const;
export type CoresConvite = { fundo: string; tinta: string; destaque: string };
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const hex = (c: number[]) => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
export function luminancia(cor: string) {
  const [r, g, b] = rgb(cor).map(v => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; });
  return r * .2126 + g * .7152 + b * .0722;
}
export function contraste(a: string, b: string) {
  const x = luminancia(a), y = luminancia(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
export function tintaLegivel(fundo: string, preferida?: string) {
  if (preferida && contraste(fundo, preferida) >= 4.5) return preferida;
  return contraste(fundo, '#ffffff') > contraste(fundo, '#000000') ? '#ffffff' : '#000000';
}
export function temaVisual(c: Conteudo) {
  const base = temas[c.tema], cores = c.visual?.cores;
  return cores ? { ...base, ...cores, tinta: tintaLegivel(cores.fundo, cores.tinta) } : base;
}

/** Mesmo enquadramento de object-fit/object-position usado na prévia e no PNG. */
export function enquadramento(iw: number, ih: number, w: number, h: number, visual = { ...visualPadrao } as NonNullable<Conteudo['visual']>) {
  const escala = visual.ajuste === 'preencher' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
  return { x: (w - iw * escala) * visual.x / 100, y: (h - ih * escala) * visual.y / 100, largura: iw * escala, altura: ih * escala };
}

/** Quantização local: ignora transparência e prioriza a cor cromática predominante. */
export function paletaDosPixels(pixels: ArrayLike<number>): CoresConvite {
  const grupos = new Map<string, { n: number; soma: number[]; saturacao: number }>();
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const c = [pixels[i], pixels[i + 1], pixels[i + 2]], chave = c.map(v => Math.floor(v / 32)).join(',');
    const grupo = grupos.get(chave) ?? { n: 0, soma: [0, 0, 0], saturacao: (Math.max(...c) - Math.min(...c)) / 255 };
    grupo.n++; c.forEach((v, n) => { grupo.soma[n] += v; }); grupos.set(chave, grupo);
  }
  if (!grupos.size) throw new Error('A imagem não tem cores visíveis. Escolha as cores manualmente.');
  const todos = [...grupos.values()], cromaticos = todos.filter(g => g.saturacao > .15);
  const escolhidos = cromaticos.length ? cromaticos : todos;
  escolhidos.sort((a, b) => b.n * (1 + b.saturacao) - a.n * (1 + a.saturacao));
  const dominante = escolhidos[0], cor = dominante.soma.map(v => v / dominante.n);
  // Fundo suave conserva a família de cor; destaque conserva a cor amostrada.
  const fundo = hex(cor.map(v => v * .14 + 255 * .86));
  return { fundo, destaque: hex(cor), tinta: tintaLegivel(fundo, hex(cor.map(v => v * .3))) };
}

export async function extrairPaleta(url: string): Promise<CoresConvite> {
  const img = new Image(); img.src = url; await img.decode();
  const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Não foi possível ler as cores. Escolha as cores manualmente.');
  ctx.drawImage(img, 0, 0, 64, 64);
  return paletaDosPixels(ctx.getImageData(0, 0, 64, 64).data);
}
