/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

test('download completo mantém dimensões naturais novas e antigas sem enquadrar nem aplicar textos', async () => {
  const source = fs.readFileSync('components/convites/ConviteArte.tsx', 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  for (const [width, height] of [[1024,1536], [768,1024]]) {
    const draws = [];
    const ctx = { fillRect() {}, drawImage(...args) { draws.push(args); } };
    const canvas = { width: 0, height: 0, getContext: () => ctx, toBlob: cb => cb({}) };
    let downloaded = false;
    const exports = {};
    vm.runInNewContext(code, {
      exports,
      require: id => id.includes('modelos') ? { modeloBiblioteca: () => false, modeloComFoto: () => false }
        : id.includes('visual') ? { temaVisual: () => ({ fundo: '#000' }), visualPadrao: {} } : {},
      document: { createElement: tag => tag === 'canvas' ? canvas : { click() { downloaded = true; } } },
      Image: class { constructor() { this.naturalWidth = width; this.naturalHeight = height; } async decode() {} },
      URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL() {} },
      setTimeout: fn => fn(),
    });
    await exports.baixarConvite({ tema: 'livre', visual: { modo: 'completa', ajuste: 'preencher', x: 100, y: 0 } }, 'imagem-sintetica');
    assert.equal(canvas.width, width); assert.equal(canvas.height, height);
    assert.equal(draws.length, 1); assert.deepEqual(Array.from(draws[0].slice(1)), [0,0]);
    assert.equal(downloaded, true);
  }
});
