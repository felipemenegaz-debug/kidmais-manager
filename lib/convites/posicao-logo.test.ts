import assert from 'node:assert/strict';
import test from 'node:test';
import {
  caixaDaLogo, caixaEmPorcento, escolherVencedor, logoAutomatica, logoSobreAtiva, procurarAreaReservada, projecaoPublicaLogo,
  sugerirPosicaoLogo, type ConteudoComLogo, type ImagemRGBA, type LogoRGBA,
} from './posicao-logo.ts';

// ---------------------------------------------------------------- fixtures do plano (§3 e §3.1)
const W = 1080, H = 1440;
type Pinta = (x: number, y: number) => number | null; // cinza ou null = usar o ruído
function arte(fundo: 'ruido' | number, sobre: Pinta = () => null): ImagemRGBA {
  const rgba = new Uint8Array(W * H * 4);
  let s = 12345 >>> 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v: number;
    if (fundo === 'ruido') { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; v = s % 256; } else v = fundo;
    const p = sobre(x, y); if (p !== null) v = p;
    const k = (y * W + x) * 4; rgba[k] = rgba[k + 1] = rgba[k + 2] = v; rgba[k + 3] = 255;
  }
  return { rgba, W, H };
}
function logo(cinza: number, alfa = 255): LogoRGBA {
  const rgba = new Uint8Array(400 * 100 * 4);
  for (let k = 0; k < rgba.length; k += 4) { rgba[k] = rgba[k + 1] = rgba[k + 2] = cinza; rgba[k + 3] = alfa; }
  return { rgba, wl: 400, hl: 100 };
}
const ESCURA = logo(0x20), CLARA = logo(0xF0), TRANSPARENTE = logo(0x20, 0);
const dentro = (x0: number, x1: number, y0: number, y1: number) => (x: number, y: number) => x >= x0 && x < x1 && y >= y0 && y < y1;
const branco = (...rets: [number, number, number, number][]): Pinta => (x, y) => rets.some(r => dentro(...r)(x, y)) ? 255 : null;
const xadrez: Pinta = (x, y) => (Math.floor(x / 24) + Math.floor(y / 24)) % 2 ? 0 : 255;
const linhas: Pinta = (x, y) => x >= 300 && x < 780 && y >= 1300 && y < 1398 && (y - 1300) % 6 < 2 ? 0 : null;

const cache = new Map<string, ImagemRGBA>();
const artes: Record<string, () => ImagemRGBA> = {
  cinza: () => arte(0x80),
  b: () => arte('ruido', branco([680, 1080, 1040, 1440])),
  ruido: () => arte('ruido'),
  e: () => arte('ruido', branco([0, 1080, 1040, 1440])),
  g: () => arte(255, linhas),
  h: () => arte(255, xadrez),
  r1: () => arte('ruido', branco([240, 840, 1000, 1160])),
  r3: () => arte('ruido', branco([0, 400, 1000, 1160])),
  r7: () => arte('ruido', branco([240, 840, 1040, 1110])),
  r8: () => arte('ruido', branco([100, 520, 1000, 1160], [560, 980, 1000, 1160])),
};
const A = (nome: string) => { if (!cache.has(nome)) cache.set(nome, artes[nome]!()); return cache.get(nome)!; };
const perto = (real: number, esperado: number, rotulo: string) => assert.ok(Math.abs(real - esperado) <= 1e-6, `${rotulo}: ${real} ≠ ${esperado}`);

const TABELA_3: [string, string, LogoRGBA, number, number, number, boolean, number, boolean, number[] | null][] = [
  ['(a)', 'cinza', ESCURA, 1, 50, 94.3125, false, 0, false, [0, 0, 0, 0, 0, 0]],
  ['(b)', 'b', ESCURA, 2, 87, 94.3125, false, 0, false, [0.389476, 0, 0.294898, 0.299647, 0.283014, 0.291061]],
  ['(c)', 'b', CLARA, 2, 86.46, 93.9075, true, 0, false, [0.389476, 0, 0.294898, 0.299647, 0.283014, 0.291061]],
  ['(d)', 'ruido', ESCURA, 5, 87, 5.6875, false, 0.283014, false, [0.294583, 0.29951, 0.294898, 0.299647, 0.283014, 0.291061]],
  ['(e)', 'e', ESCURA, 1, 50, 94.3125, false, 0, false, [0, 0, 0, 0.299647, 0.283014, 0.291061]],
  ['(f)', 'cinza', TRANSPARENTE, 1, 50, 93.9075, true, 0, false, [0, 0, 0, 0, 0, 0]],
  ['(g)', 'g', ESCURA, 4, 50, 5.6875, false, 0, false, [0.361595, 0.038093, 0.038093, 0, 0, 0]],
  ['(h)', 'h', ESCURA, 1, 50, 93.9075, true, 0.85589, true, [0.85589, 0.854085, 0.852714, 0.854257, 0.852427, 0.85106]],
];
// A tabela do plano traz as pontuações com 6 casas: comparação com meia unidade da 6ª casa.
const perto6 = (real: number, esperado: number, rotulo: string) => assert.ok(Math.abs(real - esperado) <= 5e-7 + 1e-9, `${rotulo}: ${real} ≠ ${esperado}`);

for (const [nome, a, l, venc, x, y, fundo, pont, sem, pontuacoes] of TABELA_3) {
  test(`§3 fixture ${nome}`, () => {
    const s = sugerirPosicaoLogo(A(a), l);
    assert.equal(s.candidato, venc, `${nome} vencedor`);
    perto(s.x, x, `${nome} x`); perto(s.y, y, `${nome} y`);
    assert.equal(s.fundo, fundo, `${nome} fundo`); assert.equal(s.semLugarLivre, sem, `${nome} semLugarLivre`);
    perto6(s.pontuacao, pont, `${nome} pontuação`);
    pontuacoes!.forEach((p, i) => perto6(s.pontuacoes[i]!, p, `${nome} C${i + 1}`));
    assert.equal(s.largura, 18);
  });
}

const TABELA_31: [string, string, LogoRGBA, string, number, number, boolean, number | null][] = [
  ['(r1)', 'r1', ESCURA, 'reservada', 50, 76, false, 0],
  ['(r2)', 'r1', CLARA, 'reservada', 50, 75, true, 0],
  ['(r3)', 'r3', ESCURA, 'reservada', 20, 76, false, 0],
  ['(r4)', 'cinza', ESCURA, 'reservada', 50, 95, false, 0],
  ['(r5)', 'ruido', ESCURA, 'sugerida', 87, 5.6875, false, null],
  ['(r6)', 'h', ESCURA, 'faixa', 50, 93.9075, true, null],
  ['(r7)', 'r7', ESCURA, 'sugerida', 87, 5.6875, false, null],
  ['(r8)', 'r8', ESCURA, 'reservada', 30, 76, false, 0],
];
for (const [nome, a, l, origem, x, y, fundo, pontArea] of TABELA_31) {
  test(`§3.1 fixture ${nome}`, () => {
    const r = logoAutomatica(A(a), l);
    assert.equal(r.origem, origem, `${nome} origem`);
    perto(r.x, x, `${nome} x`); perto(r.y, y, `${nome} y`); assert.equal(r.fundo, fundo, `${nome} fundo`);
    assert.equal(r.largura, origem === 'reservada' ? 24 : 18);
    assert.equal(r.modo, origem === 'faixa' ? 'faixa' : 'sobre');
    const area = procurarAreaReservada(A(a), l);
    assert.equal(typeof area.achou, 'boolean');
    assert.equal(area.achou, origem === 'reservada');
    assert.equal(area.candidatos.length, 728);
    if (pontArea !== null) perto6(area.pontuacao, pontArea, `${nome} pontuação`);
  });
}

test('§3.1 pontuações citadas no plano: (r5), (r6) e vizinhos da (r8)', () => {
  const r5 = procurarAreaReservada(A('ruido'), ESCURA);
  perto6(r5.pontuacao, 0.27636, '(r5) melhor'); perto(r5.x, 50, '(r5) x'); perto(r5.y, 87, '(r5) y');
  perto6(Math.min(...r5.candidatos.map(c => c.pontuacao)), 0.268022, '(r5) mínimo');
  const r6 = procurarAreaReservada(A('h'), ESCURA);
  perto6(r6.pontuacao, 0.853755, '(r6) melhor'); perto(r6.y, 93, '(r6) y');
  perto6(Math.min(...r6.candidatos.map(c => c.pontuacao)), 0.848425, '(r6) mínimo');
  const r8 = procurarAreaReservada(A('r8'), ESCURA);
  const em = (x: number, y: number) => r8.candidatos.find(c => c.x === x && c.y === y)!.pontuacao;
  perto6(em(35, 76), 0.115775, '(35,76)'); perto6(em(50, 76), 0.264072, '(50,76)'); perto6(em(65, 76), 0.120789, '(65,76)');
  assert.equal(r8.candidatos.filter(c => c.pontuacao <= 0.01).length, 12);
  const r1 = procurarAreaReservada(A('r1'), ESCURA);
  assert.equal(r1.candidatos.filter(c => c.pontuacao <= 0.01).length, 15);
});

test('§3.1 escolherVencedor não depende da ordem dos itens (r8 invertida)', () => {
  const r8 = procurarAreaReservada(A('r8'), ESCURA);
  const v = escolherVencedor([...r8.candidatos].reverse());
  assert.deepEqual([v.x, v.y], [30, 76]);
});

// ---------------------------------------------------------------- §1: regra de exibição
const ARTE = '11111111-1111-4111-8111-111111111111', OUTRA = '22222222-2222-4222-8222-222222222222';
const SOBRE = { modo: 'sobre' as const, arteId: ARTE, x: 40, y: 60, largura: 20, fundo: true, origem: 'buffet' as const };
const base: ConteudoComLogo = { arteId: ARTE, visual: { modo: 'completa' }, logoPosicoes: { [ARTE]: SOBRE } };

test('logoSobreAtiva: as quatro condições, uma a uma', () => {
  assert.equal(logoSobreAtiva(base), true);
  assert.equal(logoSobreAtiva({ ...base, logoBuffet: false }), false, '1. logo desligada');
  assert.equal(logoSobreAtiva({ ...base, logoBuffet: true }), true);
  assert.equal(logoSobreAtiva({ ...base, logoPosicoes: { [ARTE]: { ...SOBRE, modo: 'faixa' } } }), false, '2. modo faixa');
  assert.equal(logoSobreAtiva({ ...base, visual: { modo: 'modelo' } }), false, '3. modo modelo');
  assert.equal(logoSobreAtiva({ ...base, visual: undefined }), false, '3. sem visual');
  assert.equal(logoSobreAtiva({ ...base, arteId: null }), false, '3. sem arte');
  assert.equal(logoSobreAtiva({ ...base, arteId: OUTRA }), false, '4. arte sem entrada');
  assert.equal(logoSobreAtiva({ ...base, logoPosicoes: { [ARTE]: { ...SOBRE, arteId: OUTRA } } }), false, '4. entrada de outra arte');
  assert.equal(logoSobreAtiva({ ...base, logoPosicoes: undefined }), false, 'sem mapa');
});

test('projecaoPublicaLogo: lista permitida e null nos casos de faixa', () => {
  assert.deepEqual(projecaoPublicaLogo(base, true), { x: 40, y: 60, largura: 20, fundo: true });
  assert.deepEqual(Object.keys(projecaoPublicaLogo(base, true)!).sort(), ['fundo', 'largura', 'x', 'y']);
  assert.equal(projecaoPublicaLogo(base, false), null, 'sem logo no Perfil');
  assert.equal(projecaoPublicaLogo({ ...base, logoBuffet: false }, true), null);
  assert.equal(projecaoPublicaLogo({ ...base, visual: { modo: 'modelo' } }, true), null);
  assert.equal(projecaoPublicaLogo({ ...base, arteId: OUTRA }, true), null);
});

// ---------------------------------------------------------------- §2: geometria
test('caixaDaLogo: horizontal, vertical, quadrada, limites de largura e altura', () => {
  const T = { W: 1000, H: 1400 };
  const h = caixaDaLogo(T, { x: 50, y: 50, largura: 20, fundo: false }, 10);
  assert.deepEqual(h.logo, { x0: 400, y0: 690, w: 200, h: 20 }); assert.equal(h.pilula, null); assert.equal(h.final, h.logo);
  const v = caixaDaLogo(T, { x: 50, y: 50, largura: 40, fundo: false }, 0.1); // h = 4000 > 0,25·H → 350
  assert.equal(v.logo.h, 350); perto(v.logo.w, 35, 'w vertical');
  const q = caixaDaLogo(T, { x: 50, y: 50, largura: 8, fundo: false }, 1);
  assert.deepEqual([q.logo.w, q.logo.h], [80, 80]);
  const g = caixaDaLogo(T, { x: 50, y: 50, largura: 40, fundo: false }, 4);
  assert.deepEqual([g.logo.w, g.logo.h], [400, 100]);
});

test('caixaDaLogo: pílula de 12% do menor lado e centro limitado nas quatro bordas', () => {
  const T = { W: 1000, H: 1400 };
  const p = caixaDaLogo(T, { x: 50, y: 50, largura: 20, fundo: true }, 10);
  perto(p.pilula!.w, 200 + 2 * 2.4, 'pílula w'); perto(p.pilula!.h, 20 + 2 * 2.4, 'pílula h');
  for (const [x, y] of [[0, 0], [100, 100], [0, 100], [100, 0]] as const) {
    const c = caixaDaLogo(T, { x, y, largura: 40, fundo: true }, 10);
    const f = c.final;
    assert.ok(f.x0 >= -1e-9 && f.y0 >= -1e-9 && f.x0 + f.w <= T.W + 1e-9 && f.y0 + f.h <= T.H + 1e-9, `${x},${y}`);
    perto(c.logo.x0 - f.x0, 0.12 * Math.min(c.logo.w, c.logo.h), 'logo dentro da pílula');
  }
  // Troca de proporção com a mesma posição: centro igual, tamanho novo.
  const a = caixaDaLogo(T, { x: 30, y: 40, largura: 20, fundo: false }, 4), b = caixaDaLogo(T, { x: 30, y: 40, largura: 20, fundo: false }, 2);
  perto(a.logo.x0 + a.logo.w / 2, b.logo.x0 + b.logo.w / 2, 'cx'); perto(a.logo.y0 + a.logo.h / 2, b.logo.y0 + b.logo.h / 2, 'cy');
});

test('geometria: tela (em %) e PNG batem em até 1 px natural em 320, 360, 768 e 1080 px', () => {
  const casos = [
    { prop: 10, pos: { x: 0, y: 0, largura: 40, fundo: true } }, { prop: 10, pos: { x: 100, y: 0, largura: 40, fundo: true } },
    { prop: 10, pos: { x: 0, y: 100, largura: 40, fundo: true } }, { prop: 10, pos: { x: 100, y: 100, largura: 40, fundo: true } },
    { prop: 0.1, pos: { x: 50, y: 50, largura: 30, fundo: false } }, { prop: 2.3, pos: { x: 37.4, y: 81.2, largura: 18, fundo: true } },
  ];
  for (const T of [{ W: 1080, H: 1440 }, { W: 1024, H: 1536 }, { W: 777, H: 1001 }]) for (const { prop, pos } of casos) {
    const c = caixaDaLogo(T, pos, prop);
    const png = { x0: Math.round(c.logo.x0), y0: Math.round(c.logo.y0), w: Math.round(c.logo.w), h: Math.round(c.logo.h) };
    for (const tela of [320, 360, 768, 1080]) {
      const pc = caixaEmPorcento(c.logo, T);
      const escala = tela / T.W; // a caixa da tela tem a proporção natural
      const px = { x0: pc.left / 100 * tela, y0: pc.top / 100 * T.H * escala, w: pc.width / 100 * tela, h: pc.height / 100 * T.H * escala };
      const volta = { x0: px.x0 / escala, y0: px.y0 / escala, w: px.w / escala, h: px.h / escala };
      for (const k of ['x0', 'y0', 'w', 'h'] as const) assert.ok(Math.abs(volta[k] - png[k]) <= 1, `${tela}px ${k}`);
    }
  }
});

test('§3: texto fino em 1080 px não some na redução para 256', () => {
  // Linhas de 2 px (como a fixture g) em cima, à esquerda: C6 não pode vencer com pontuação baixa.
  const fino = arte(255, (x, y) => x >= 20 && x < 400 && y >= 30 && y < 140 && (y - 30) % 6 < 2 ? 0 : null);
  const s = sugerirPosicaoLogo(fino, ESCURA);
  assert.ok(s.pontuacoes[5]! > 0.01, `C6 = ${s.pontuacoes[5]}`);
  assert.notEqual(s.candidato, 6);
});
