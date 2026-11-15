/* eslint-disable @typescript-eslint/no-require-imports */
// Etapa 2 da logo do buffet (15/11/2026): a imagem baixada ganha a faixa com a logo abaixo da arte, sem mudar a arte.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync('components/convites/ConviteArte.tsx', 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function montar({ biblioteca = false, arte = { w: 1024, h: 1536 }, logo = { w: 300, h: 150 }, logoFalha = false } = {}) {
  const canvases = [], baixados = [];
  const novoCanvas = () => {
    const c = { width: 0, height: 0, ops: [] };
    c.getContext = () => ({ fillRect: (...a) => c.ops.push(['fillRect', ...a]), drawImage: (img, ...a) => c.ops.push(['drawImage', img.origem ?? (img.ops ? 'canvas' : 'img'), ...a]), set fillStyle(v) { c.ops.push(['fillStyle', v]); } });
    c.toBlob = cb => cb({ canvas: c });
    canvases.push(c); return c;
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require: id => id.includes('modelos') ? { modeloBiblioteca: () => biblioteca, modeloComFoto: () => false, svgModelo: () => '<svg/>', planetasModelo: [] }
      : id.includes('faixa-logo') ? faixaLogo
      : id.includes('visual') ? { temaVisual: () => ({ fundo: '#000' }), visualPadrao: {} } : {},
    document: { createElement: tag => tag === 'canvas' ? novoCanvas() : { click() { baixados.push(this.href); } } },
    Image: class {
      set src(v) { this.origem = v; const d = v === 'logo' ? logo : arte; this.naturalWidth = d.w; this.naturalHeight = d.h; }
      async decode() { if (this.origem === 'logo' && logoFalha) throw new Error('falha'); }
    },
    Blob: class {}, FileReader: class { readAsDataURL() { this.result = 'data:arte'; this.onload(); } },
    fetch: async () => ({ ok: true, blob: async () => ({}) }),
    URL: { createObjectURL: b => (b && b.canvas ? (baixados.final = b.canvas, 'blob:png') : 'blob:svg'), revokeObjectURL() {} },
    setTimeout: fn => fn(),
  });
  return { baixar: exports.baixarConvite, baixados, canvases };
}
const faixaLogo = (() => {
  const js = ts.transpileModule(fs.readFileSync('lib/convites/faixa-logo.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {}; vm.runInNewContext(js, { exports, Math, Number }); return exports;
})();
const completa = { tema: 'livre', visual: { modo: 'completa', ajuste: 'preencher', x: 0, y: 0 } };

test('arte completa + logo: arte intacta em cima, faixa clara e logo inteira embaixo', async () => {
  const f = montar();
  await f.baixar(completa, 'arte', 'logo');
  const final = f.baixados.final, m = faixaLogo.medidasFaixaLogo(1024, 1536, 300, 150);
  assert.equal(final.width, 1024); assert.equal(final.height, 1536 + m.faixa);
  assert.deepEqual(final.ops[0], ['drawImage', 'canvas', 0, 0], 'a arte entra primeiro, sem escala nem recorte');
  assert.deepEqual(final.ops.find(o => o[0] === 'fillRect'), ['fillRect', 0, 1536, 1024, m.faixa], 'faixa começa onde a arte termina');
  assert.deepEqual(final.ops.at(-1), ['drawImage', 'logo', m.x, m.y, m.largura, m.altura]);
  assert.equal(f.canvases[0].height, 1536, 'canvas da arte não muda');
});

test('sem logo ou logo desligada: download igual ao de antes', async () => {
  for (const logo of [undefined, null, '']) {
    const f = montar();
    await f.baixar(completa, 'arte', logo);
    assert.equal(f.canvases.length, 1); assert.equal(f.baixados.final.height, 1536);
  }
});

test('logo que não carrega não impede o download: sai sem faixa', async () => {
  const f = montar({ logoFalha: true });
  await f.baixar(completa, 'arte', 'logo');
  assert.equal(f.baixados.final.height, 1536); assert.equal(f.baixados.length, 1);
});

// Astra r1 (P3): o caminho baixarModelo nas duas alturas, com as mesmas garantias da arte completa.
const modelos = [
  ['1440 (arte própria em modelo sem foto)', { biblioteca: false }, { tema: 'livre', visual: {} }, 'arte', 1440],
  ['1800 (modelo da biblioteca, arte no topo)', { biblioteca: true }, { tema: 'planetas', visual: { posicao: 'topo' } }, undefined, 1800],
];
for (const [nome, opcoes, conteudo, arte, altura] of modelos) {
  test(`modelo ${nome}: arte intacta, faixa logo abaixo e logo inteira nela`, async () => {
    const f = montar(opcoes);
    await f.baixar(conteudo, arte, 'logo');
    const final = f.baixados.final, m = faixaLogo.medidasFaixaLogo(1080, altura, 300, 150);
    assert.equal(f.canvases[0].height, altura, 'canvas do modelo não muda');
    assert.deepEqual(f.canvases[0].ops.filter(o => o[0] === 'drawImage'), [['drawImage', 'blob:svg', 0, 0]], 'modelo desenhado uma vez, sem escala');
    assert.equal(final.width, 1080); assert.equal(final.height, altura + m.faixa);
    assert.deepEqual(final.ops[0], ['drawImage', 'canvas', 0, 0], 'o modelo entra primeiro, sem escala nem recorte');
    assert.deepEqual(final.ops.find(o => o[0] === 'fillRect'), ['fillRect', 0, altura, 1080, m.faixa], 'faixa começa onde o modelo termina');
    assert.deepEqual(final.ops.at(-1), ['drawImage', 'logo', m.x, m.y, m.largura, m.altura]);
    assert.equal(f.baixados.length, 1);
  });
  test(`modelo ${nome}: sem logo ou logo que não carrega, download igual ao de antes`, async () => {
    for (const [logo, logoFalha] of [[undefined, false], [null, false], ['', false], ['logo', true]]) {
      const f = montar({ ...opcoes, logoFalha });
      await f.baixar(conteudo, arte, logo);
      assert.equal(f.canvases.length, 1, 'nenhum canvas extra'); assert.equal(f.baixados.final, f.canvases[0]);
      assert.equal(f.baixados.final.height, altura); assert.equal(f.baixados.length, 1);
    }
  });
}
