// E-CP2 (04/11/2026): imagem própria como fundo com faixa translúcida e sem textos de exemplo.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { temas, type Conteudo } from './domain.ts';
import { comporTexto, svgModelo } from './modelos.ts';
import { hashesAtuais } from './modelos-regressao.fixture.ts';
import { opacidadeFaixa, temaVisual } from './visual.ts';

// Contraste recalculado aqui, sem reutilizar visual.ts: o oráculo não pode herdar um erro do código testado.
const canal = (v: number) => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; };
const lum = (c: number[]) => .2126 * canal(c[0]) + .7152 * canal(c[1]) + .0722 * canal(c[2]);
const rgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const razao = (a: number, b: number) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
/** Fundo efetivo da faixa (composição sRGB) sobre um pixel da foto. */
const efetivo = (faixa: string, alfa: number, foto: number[]) => rgb(faixa).map((v, i) => alfa * v + (1 - alfa) * foto[i]);

const exemplos = ['Nome do aniversariante', 'Um dia muito especial', 'Data da festa', '00:00', 'Local da festa', 'Endereço do evento'];
const cheio: Conteudo = { tema: 'celebrar', nome: 'Ana Clara', idade: '5 anos', mensagem: 'Vem comemorar com a gente!', data: '2027-04-20', horario: '15:00', local: 'Buffet Alegria', endereco: 'Rua das Flores, 100', arteId: null, confirmarPresenca: true, visual: { modo: 'modelo', ajuste: 'conter', x: 50, y: 50 } };
const fundo = (c: Partial<Conteudo>, cores?: { fundo: string; tinta: string; destaque: string }) =>
  svgModelo({ ...cheio, ...c, visual: { ...cheio.visual!, ...(cores ? { cores } : {}) } }, { arte: '/foto.webp' });

/** Lê do SVG emitido a faixa e a tinta dos textos. */
function faixaDoSvg(svg: string) {
  const m = svg.match(/<rect x="(\d+)" y="([\d.]+)" width="(\d+)" height="([\d.]+)" rx="48" fill="(#[0-9a-f]{6})" fill-opacity="([\d.]+)"\/>/i);
  assert(m, 'faixa ausente');
  const tintas = [...svg.matchAll(/<g fill="(#[0-9a-f]{6})" font-family/gi)].map(x => x[1]);
  assert(tintas.length > 0);
  assert.equal(new Set(tintas).size, 1);
  assert(svg.indexOf(m[0]) < svg.indexOf('<text'), 'faixa precisa vir antes dos textos');
  return { x: +m[1], y: +m[2], largura: +m[3], altura: +m[4], cor: m[5], alfa: +m[6], tinta: tintas[0] };
}
/** Oráculo: contraste >= 4,5 com foto preta, branca e numa grade 6x6x6, sempre do mesmo lado da tinta. */
function assertContraste(svg: string, rotulo: string) {
  const f = faixaDoSvg(svg), t = lum(rgb(f.tinta));
  const passos = [0, 51, 102, 153, 204, 255];
  let lado: boolean | undefined;
  for (const r of passos) for (const g of passos) for (const b of passos) {
    const l = lum(efetivo(f.cor, f.alfa, [r, g, b]));
    assert(razao(l, t) >= 4.5, `${rotulo}: contraste ${razao(l, t).toFixed(3)} com foto ${r},${g},${b} e alfa ${f.alfa}`);
    lado ??= l >= t;
    assert.equal(l >= t, lado, `${rotulo}: a foto ${r},${g},${b} atravessa a luminância da tinta`);
  }
  return f;
}

test('fundo próprio: faixa única antes dos textos, sem filtros ou paths, e todos os dados presentes', () => {
  const svg = fundo({});
  assert.equal((svg.match(/<image /g) ?? []).length, 1);
  assert(!svg.includes('<filter') && !svg.includes('<path'));
  assert.equal((svg.match(/<rect /g) ?? []).length, 2);
  for (const valor of ['VAMOS CELEBRAR', 'Ana Clara', '5 anos', 'Vem comemorar com a gente!', '20 de abril · 15:00', 'Buffet Alegria', 'Rua das Flores, 100']) assert(svg.includes(valor), valor);
  const f = faixaDoSvg(svg);
  assert.equal(f.cor, temas.celebrar.fundo);
  assert.equal(f.alfa, .8);
});

test('opacidade emitida no SVG garante contraste em todos os temas e em 200 cores próprias', () => {
  for (const tema of Object.keys(temas) as Conteudo['tema'][]) {
    if (tema.startsWith('foto_')) continue; // temas com foto usam o passe-partout, não o fundo próprio
    assert.equal(assertContraste(fundo({ tema }), tema).alfa, .8, tema);
  }
  let semente = 20261104;
  const aleatorio = () => (semente = (semente * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const cor = () => `#${Array.from({ length: 3 }, () => Math.floor(aleatorio() * 256).toString(16).padStart(2, '0')).join('')}`;
  const alfas = new Set<number>();
  for (let n = 0; n < 200; n++) {
    const cores = { fundo: cor(), tinta: cor(), destaque: cor() };
    const f = assertContraste(fundo({}, cores), `cores ${JSON.stringify(cores)}`);
    assert.equal(f.cor, cores.fundo);
    assert.equal(f.tinta, temaVisual({ ...cheio, visual: { ...cheio.visual!, cores } }).tinta);
    alfas.add(f.alfa);
  }
  assert(alfas.size > 1, 'a amostra precisa exercitar mais de uma opacidade');
});

test('casos de fronteira: a opacidade emitida acompanha as cores próprias', () => {
  for (const [cores, alfa] of [[{ fundo: '#777777', tinta: '#000000', destaque: '#aa3300' }, .98], [{ fundo: '#767676', tinta: '#ffffff', destaque: '#aa3300' }, 1]] as const) {
    assert.equal(opacidadeFaixa(cores.fundo, cores.tinta), alfa);
    const f = assertContraste(fundo({}, cores), cores.fundo);
    assert.equal(f.alfa, alfa);
  }
  assert.equal(faixaDoSvg(fundo({ tema: 'planetas' })).alfa, .8);
});

test('sem textos de exemplo sobre a foto; idade e mensagem vazias somem', () => {
  const publicado = fundo({ idade: '', mensagem: '' });
  assert(!publicado.includes('Um dia muito especial'));
  for (const valor of ['Ana Clara', '20 de abril · 15:00', 'Buffet Alegria']) assert(publicado.includes(valor));
  const vazio = fundo({ nome: '', idade: '', mensagem: '', data: '', horario: '', local: '', endereco: '' });
  for (const exemplo of exemplos) assert(!vazio.includes(`>${exemplo}<`), exemplo);
  assert.equal((vazio.match(/<text /g) ?? []).length, 1);
  assert(vazio.includes('VAMOS CELEBRAR'));
  faixaDoSvg(vazio);
  const espacos = fundo({ nome: '   ', idade: ' ', mensagem: '  ', horario: '', data: '', local: ' ', endereco: '   ' });
  assert.equal((espacos.match(/<text /g) ?? []).length, 1);
  assert(fundo({ horario: '' }).includes('>20 de abril<'));
  assert(fundo({ data: '' }).includes('>às 15:00<'));
  assert(!fundo({ data: '', horario: '' }).includes(' · '));
});

test('a faixa cobre todas as linhas desenhadas, inclusive nos limites do schema', () => {
  const limites = { nome: 'Maria Eduarda Aparecida de Albuquerque e Vasconcelos Lima'.padEnd(80, 'x'), mensagem: 'Vamos comemorar juntos! '.repeat(17).slice(0, 400), local: 'L'.repeat(120), endereco: 'Avenida '.repeat(30).slice(0, 240), idade: 'x'.repeat(20) };
  for (const caso of [{}, limites, { ...limites, idade: '', mensagem: '' }, { nome: 'W'.repeat(80) }]) {
    const svg = fundo(caso), f = faixaDoSvg(svg);
    for (const grupo of svg.matchAll(/<g fill="#[0-9a-f]{6}"[^>]*font-size="([\d.]+)"[^>]*>(.*?)<\/g>/gi)) {
      const tamanho = +grupo[1];
      for (const linha of grupo[2].matchAll(/<text x="540" y="([\d.]+)"/g)) {
        const base = +linha[1];
        assert(base - tamanho >= f.y && base + tamanho * .25 <= f.y + f.altura, `linha em ${base} fora da faixa ${f.y}–${f.y + f.altura}`);
      }
    }
    assert(f.x <= 540 - 740 / 2 && f.x + f.largura >= 540 + 740 / 2);
    assert(f.y >= 0 && f.y + f.altura <= 1440);
  }
  assert.equal(comporTexto('W'.repeat(80), 740, 230, 110).linhas.join(''), 'W'.repeat(80));
});

test('dados e URL continuam escapados no fundo próprio', () => {
  const svg = svgModelo({ ...cheio, nome: '<script>&"', local: '"/><x>' }, { arte: '"/><script>alert(1)</script>' });
  assert(!svg.includes('<script>') && !svg.includes('<x>'));
  assert(svg.includes('&lt;script&gt;&amp;&quot;'));
});

test('topo, modelos sem arte, miniaturas e temas com foto ficam byte a byte iguais à production 767fff4a', () => {
  const congelados = JSON.parse(readFileSync(new URL('./modelos-regressao-767fff4a.json', import.meta.url), 'utf8')) as Record<string, string>;
  const atuais = hashesAtuais();
  assert.equal(Object.keys(atuais).length, Object.keys(congelados).length);
  const diferentes = Object.keys(congelados).filter(chave => atuais[chave] !== congelados[chave]);
  assert.deepEqual(diferentes, []);
});
