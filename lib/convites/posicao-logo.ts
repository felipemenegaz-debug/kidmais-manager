/**
 * Logo do buffet sobre a arte do convite completo (etapa 3, plano r15.1 de 16/11/2026).
 *
 * Módulo puro e determinístico, usado no navegador (editor, download, página pública) e no servidor (logo automática
 * na conclusão da geração por IA). Nada aqui lê banco, rede ou DOM.
 *
 * - `logoSobreAtiva`: regra única de exibição (§1).
 * - `caixaDaLogo`: geometria única em pixels naturais da arte (§2).
 * - `sugerirPosicaoLogo`: lugar sugerido por heurística, sem IA (§3).
 * - `procurarAreaReservada`, `escolherVencedor`, `logoAutomatica`: área deixada pela IA para a logo (§3.1).
 */

export type ModoLogo = 'faixa' | 'sobre';
export type OrigemLogo = 'reservada' | 'sugerida' | 'faixa' | 'buffet';
export type PosicaoLogo = { modo: ModoLogo; arteId: string; x: number; y: number; largura: number; fundo: boolean; origem?: OrigemLogo };
export type ConteudoComLogo = {
  arteId?: string | null;
  logoBuffet?: boolean;
  logoPosicoes?: Record<string, PosicaoLogo>;
  visual?: { modo: 'modelo' | 'completa' } | null;
};
export type Caixa = { x0: number; y0: number; w: number; h: number };
export type CaixaDaLogo = { logo: Caixa; pilula: Caixa | null; final: Caixa };
export type ImagemRGBA = { rgba: Uint8Array | Uint8ClampedArray; W: number; H: number };
export type LogoRGBA = { rgba: Uint8Array | Uint8ClampedArray; wl: number; hl: number };

export const LARGURA_MIN_LOGO = 8;
export const LARGURA_MAX_LOGO = 40;
export const LARGURA_SUGERIDA = 18;
export const LARGURA_RESERVADA = 24;
export const LIMIAR_SEM_LUGAR = 0.35;
export const LIMIAR_AREA_RESERVADA = 0.08;

/** Entrada da logo da arte mostrada nesse conteúdo (rascunho ou publicado), se houver. */
export function entradaDaArte(conteudo: ConteudoComLogo | null | undefined): PosicaoLogo | null {
  const arteId = conteudo?.arteId;
  if (!arteId) return null;
  const entrada = conteudo.logoPosicoes?.[arteId];
  return entrada && entrada.arteId === arteId ? entrada : null;
}

/** §1: a logo vai sobre a arte só com as quatro condições juntas; senão vale a faixa (ou nada, com a logo desligada). */
export function logoSobreAtiva(conteudo: ConteudoComLogo | null | undefined): boolean {
  if (!conteudo || conteudo.logoBuffet === false) return false;
  const entrada = entradaDaArte(conteudo);
  if (!entrada || entrada.modo !== 'sobre') return false;
  return conteudo.visual?.modo === 'completa' && !!conteudo.arteId;
}

/** Página pública: só os quatro campos da posição, por lista permitida, e só quando a logo existe e está sobre a arte. */
export function projecaoPublicaLogo(conteudo: ConteudoComLogo | null | undefined, temLogo: boolean): { x: number; y: number; largura: number; fundo: boolean } | null {
  if (!temLogo || !logoSobreAtiva(conteudo)) return null;
  const e = entradaDaArte(conteudo)!;
  return { x: e.x, y: e.y, largura: e.largura, fundo: e.fundo };
}

const limitar = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** §2: W × H = tamanho natural da arte; proporcaoLogo = largura/altura natural da logo atual. Sem arredondar. */
export function caixaDaLogo(arte: { W: number; H: number }, posicao: { x: number; y: number; largura: number; fundo: boolean }, proporcaoLogo: number): CaixaDaLogo {
  const { W, H } = arte;
  let w = W * posicao.largura / 100, h = w / proporcaoLogo;
  if (h > 0.25 * H) { h = 0.25 * H; w = h * proporcaoLogo; }
  const p = posicao.fundo ? 0.12 * Math.min(w, h) : 0;
  const fw = w + 2 * p, fh = h + 2 * p;
  const cx = limitar(W * posicao.x / 100, fw / 2, W - fw / 2), cy = limitar(H * posicao.y / 100, fh / 2, H - fh / 2);
  const logo = { x0: cx - w / 2, y0: cy - h / 2, w, h };
  const pilula = posicao.fundo ? { x0: cx - fw / 2, y0: cy - fh / 2, w: fw, h: fh } : null;
  return { logo, pilula, final: pilula ?? logo };
}

/** §2, conversão para a tela: porcentagens da caixa natural, sem arredondar. */
export function caixaEmPorcento(c: Caixa, arte: { W: number; H: number }) {
  return { left: c.x0 / arte.W * 100, top: c.y0 / arte.H * 100, width: c.w / arte.W * 100, height: c.h / arte.H * 100 };
}

export const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

// ---------------------------------------------------------------- §3: análise da arte

export type AnaliseArte = {
  W: number; H: number;
  wr: number; hr: number;
  /** passo de uma célula reduzida em pixels naturais (1/s) */
  passo: number;
  Yr: Float64Array; borda: Uint8Array;
};

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Etapas 1 e 2 do §3: redução para no máximo 256 px no maior lado (média por célula) e bordas por Sobel 3×3. */
export function analisarArte(arte: ImagemRGBA): AnaliseArte {
  const { W, H, rgba } = arte;
  const M = Math.max(W, H);
  const reduz = M > 256;
  const s = reduz ? 256 / M : 1;
  const wr = Math.max(1, Math.round(W * s)), hr = Math.max(1, Math.round(H * s));
  const passo = reduz ? M / 256 : 1;
  // Célula de cada coluna/linha de origem: centro (p + 0,5) em [i/s, (i+1)/s). Inteiro exato: floor((2p+1)·128 / M).
  const celula = (p: number) => reduz ? Math.floor((2 * p + 1) * 128 / M) : p;
  const soma = new Float64Array(wr * hr), conta = new Uint32Array(wr * hr);
  const Y = (px: number, py: number) => {
    const k = (py * W + px) * 4;
    const a = rgba[k + 3]! / 255;
    return lum(a * rgba[k]! + (1 - a) * 255, a * rgba[k + 1]! + (1 - a) * 255, a * rgba[k + 2]! + (1 - a) * 255);
  };
  const colunas = new Int32Array(W); for (let px = 0; px < W; px++) colunas[px] = celula(px);
  for (let py = 0; py < H; py++) {
    const j = celula(py);
    if (j >= hr) continue;
    for (let px = 0; px < W; px++) {
      const i = colunas[px]!;
      if (i >= wr) continue;
      soma[j * wr + i] += Y(px, py); conta[j * wr + i]! += 1;
    }
  }
  const Yr = new Float64Array(wr * hr);
  for (let j = 0; j < hr; j++) for (let i = 0; i < wr; i++) {
    const k = j * wr + i;
    if (conta[k]) { Yr[k] = soma[k]! / conta[k]!; continue; }
    // Sem pixel de origem: o mais próximo do centro da célula.
    const px = limitar(Math.round((i + 0.5) * passo - 0.5), 0, W - 1), py = limitar(Math.round((j + 0.5) * passo - 0.5), 0, H - 1);
    Yr[k] = Y(px, py);
  }
  const z = (i: number, j: number) => Yr[limitar(j, 0, hr - 1) * wr + limitar(i, 0, wr - 1)]!;
  const borda = new Uint8Array(wr * hr);
  for (let j = 0; j < hr; j++) for (let i = 0; i < wr; i++) {
    const gx = (z(i + 1, j - 1) + 2 * z(i + 1, j) + z(i + 1, j + 1)) - (z(i - 1, j - 1) + 2 * z(i - 1, j) + z(i - 1, j + 1));
    const gy = (z(i - 1, j + 1) + 2 * z(i, j + 1) + z(i + 1, j + 1)) - (z(i - 1, j - 1) + 2 * z(i, j - 1) + z(i + 1, j - 1));
    borda[j * wr + i] = Math.sqrt(gx * gx + gy * gy) > 48 ? 1 : 0;
  }
  return { W, H, wr, hr, passo, Yr, borda };
}

/** Etapa 3 do §3: média de Y/255 dos pixels da logo com alfa > 0,5 (cor sem compor); null se não houver nenhum. */
export function luminanciaDaLogo(logo: LogoRGBA): number | null {
  let soma = 0, n = 0;
  for (let k = 0; k < logo.wl * logo.hl * 4; k += 4) {
    if (logo.rgba[k + 3]! / 255 <= 0.5) continue;
    soma += lum(logo.rgba[k]!, logo.rgba[k + 1]!, logo.rgba[k + 2]!) / 255; n++;
  }
  return n ? soma / n : null;
}

type Ret = { x0: number; x1: number; y0: number; y1: number };
const ret = (cx: number, cy: number, w: number, h: number): Ret => ({ x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 });
const expandir = (r: Ret, m: number, W: number, H: number): Ret => ({ x0: Math.max(0, r.x0 - m), x1: Math.min(W, r.x1 + m), y0: Math.max(0, r.y0 - m), y1: Math.min(H, r.y1 + m) });

/** Células cujo centro ((i+0,5)/s, (j+0,5)/s) está em R, bordas incluídas. */
function celulas(a: AnaliseArte, r: Ret): number[] {
  const out: number[] = [];
  for (let j = 0; j < a.hr; j++) {
    const cy = (j + 0.5) * a.passo;
    if (cy < r.y0 || cy > r.y1) continue;
    for (let i = 0; i < a.wr; i++) {
      const cx = (i + 0.5) * a.passo;
      if (cx >= r.x0 && cx <= r.x1) out.push(j * a.wr + i);
    }
  }
  return out;
}

function mediaL(a: AnaliseArte, r: Ret) {
  const cs = celulas(a, r);
  let s = 0; for (const k of cs) s += a.Yr[k]!;
  return cs.length ? s / cs.length / 255 : Number.NaN;
}

function pontuacaoRegiao(a: AnaliseArte, r: Ret) {
  const cs = celulas(a, r);
  if (!cs.length) return 0;
  let s = 0, e = 0; for (const k of cs) { s += a.Yr[k]!; e += a.borda[k]!; }
  const m = s / cs.length;
  let v = 0; for (const k of cs) v += (a.Yr[k]! - m) ** 2;
  const sigma = Math.sqrt(v / cs.length);
  return 0.6 * (sigma / 128) + 0.4 * (e / cs.length);
}

const precisaFundo = (L: number, Lo: number | null) => Lo === null || Math.abs(L - Lo) < 0.25;

/** Pontuação (§3) da logo na posição atual, com a margem de 0,06·min(W,H); > 0,35 = pode estar cobrindo texto. */
export function pontuacaoNaPosicao(a: AnaliseArte, posicao: { x: number; y: number; largura: number; fundo: boolean }, proporcaoLogo: number) {
  const { final } = caixaDaLogo(a, posicao, proporcaoLogo);
  const r = { x0: final.x0, x1: final.x0 + final.w, y0: final.y0, y1: final.y0 + final.h };
  return pontuacaoRegiao(a, expandir(r, 0.06 * Math.min(a.W, a.H), a.W, a.H));
}

export type Sugestao = { x: number; y: number; largura: number; fundo: boolean; pontuacao: number; semLugarLivre: boolean; candidato: number; pontuacoes: number[] };

/** §3: seis candidatos (C1..C6, que também é a ordem de desempate), menor pontuação vence, com fallback de fundo. */
export function sugerirPosicaoLogo(arte: ImagemRGBA, logo: LogoRGBA, analise = analisarArte(arte)): Sugestao {
  const { W, H } = arte;
  const prop = logo.wl / logo.hl;
  const Lo = luminanciaDaLogo(logo);
  const dims = (fundo: boolean) => { const f = caixaDaLogo({ W, H }, { x: 50, y: 50, largura: LARGURA_SUGERIDA, fundo }, prop).final; return [f.w, f.h] as const; };
  const mh = 0.04 * W, mv = 0.04 * H;
  const posicionar = (k: number, wf: number, hf: number): [number, number] => {
    const baixo = H - mv - hf / 2, cima = mv + hf / 2, dir = W - mh - wf / 2, esq = mh + wf / 2;
    return ([[W / 2, baixo], [dir, baixo], [esq, baixo], [W / 2, cima], [dir, cima], [esq, cima]] as [number, number][])[k]!;
  };
  const margem = 0.06 * Math.min(W, H);
  const reg: { cx: number; cy: number; fundo: boolean; pontuacao: number }[] = [];
  for (let k = 0; k < 6; k++) {
    const [w0, h0] = dims(false); const [cx0, cy0] = posicionar(k, w0, h0);
    const fundo = precisaFundo(mediaL(analise, ret(cx0, cy0, w0, h0)), Lo);
    const [w1, h1] = dims(fundo); const [cx, cy] = posicionar(k, w1, h1);
    reg.push({ cx, cy, fundo, pontuacao: pontuacaoRegiao(analise, expandir(ret(cx, cy, w1, h1), margem, W, H)) });
  }
  const min = Math.min(...reg.map(r => r.pontuacao));
  const vencedor = reg.findIndex(r => r.pontuacao <= min + 0.01);
  let { cx, cy, fundo } = reg[vencedor]!;
  const { pontuacao } = reg[vencedor]!;
  const semLugarLivre = pontuacao > LIMIAR_SEM_LUGAR;
  if (semLugarLivre && !fundo) {
    fundo = true; const [w2, h2] = dims(true); [cx, cy] = posicionar(vencedor, w2, h2);
  }
  return { x: round6(cx / W * 100), y: round6(cy / H * 100), largura: LARGURA_SUGERIDA, fundo, pontuacao, semLugarLivre, candidato: vencedor + 1, pontuacoes: reg.map(r => r.pontuacao) };
}

// ---------------------------------------------------------------- §3.1: área reservada

export type CandidatoArea = { ordem: number; x: number; y: number; cx: number; cy: number; fundo: boolean; pontuacao: number };

/** Pura; o resultado não depende da ordem dos itens: centro, depois mais baixo, depois menor `ordem`. */
export function escolherVencedor(reg: readonly CandidatoArea[]): CandidatoArea {
  const min = Math.min(...reg.map(r => r.pontuacao));
  const empatados = reg.filter(r => r.pontuacao <= min + 0.01);
  return [...empatados].sort((a, b) => Math.abs(a.x - 50) - Math.abs(b.x - 50) || b.y - a.y || a.ordem - b.ordem)[0]!;
}

export type AreaReservada = { achou: boolean; x: number; y: number; largura: number; fundo: boolean; pontuacao: number; candidatos: CandidatoArea[] };

export function procurarAreaReservada(arte: ImagemRGBA, logo: LogoRGBA, analise = analisarArte(arte)): AreaReservada {
  const { W, H } = arte;
  const prop = logo.wl / logo.hl;
  const Lo = luminanciaDaLogo(logo);
  const dimsR = (fundo: boolean) => { const f = caixaDaLogo({ W, H }, { x: 50, y: 50, largura: LARGURA_RESERVADA, fundo }, prop).final; return [f.w, f.h] as const; };
  const lim = (c: number, m: number, T: number) => limitar(c, m / 2, T - m / 2);
  const margem = 0.02 * Math.min(W, H);
  const [w0, h0] = dimsR(false), [wf, hf] = dimsR(true);
  const reg: CandidatoArea[] = [];
  for (let y = 40; y <= 95; y++) for (let x = 20; x <= 80; x += 5) {
    const cx0 = lim(W * x / 100, w0, W), cy0 = lim(H * y / 100, h0, H);
    const fundo = precisaFundo(mediaL(analise, ret(cx0, cy0, w0, h0)), Lo);
    const [w1, h1] = fundo ? [wf, hf] : [w0, h0];
    const cx = lim(W * x / 100, w1, W), cy = lim(H * y / 100, h1, H);
    reg.push({ ordem: reg.length, x, y, cx, cy, fundo, pontuacao: pontuacaoRegiao(analise, expandir(ret(cx, cy, w1, h1), margem, W, H)) });
  }
  const v = escolherVencedor(reg);
  return { achou: v.pontuacao <= LIMIAR_AREA_RESERVADA, x: round6(v.cx / W * 100), y: round6(v.cy / H * 100), largura: LARGURA_RESERVADA, fundo: v.fundo, pontuacao: v.pontuacao, candidatos: reg };
}

export type LogoAuto = { modo: ModoLogo; origem: Exclude<OrigemLogo, 'buffet'>; x: number; y: number; largura: number; fundo: boolean };

/** §3.1: área reservada; senão o melhor lugar livre do §3; senão a faixa. */
export function logoAutomatica(arte: ImagemRGBA, logo: LogoRGBA): LogoAuto {
  const analise = analisarArte(arte);
  const r = procurarAreaReservada(arte, logo, analise);
  if (r.achou) return { modo: 'sobre', origem: 'reservada', x: r.x, y: r.y, largura: LARGURA_RESERVADA, fundo: r.fundo };
  const s = sugerirPosicaoLogo(arte, logo, analise);
  return s.semLugarLivre
    ? { modo: 'faixa', origem: 'faixa', x: s.x, y: s.y, largura: LARGURA_SUGERIDA, fundo: s.fundo }
    : { modo: 'sobre', origem: 'sugerida', x: s.x, y: s.y, largura: LARGURA_SUGERIDA, fundo: s.fundo };
}

/** Entrada de queda da conclusão (§4 passo 5): logo sumiu do Perfil, decodificação ou cálculo falharam. */
export const LOGO_AUTO_FAIXA: LogoAuto = { modo: 'faixa', origem: 'faixa', x: 50, y: 50, largura: LARGURA_SUGERIDA, fundo: false };
