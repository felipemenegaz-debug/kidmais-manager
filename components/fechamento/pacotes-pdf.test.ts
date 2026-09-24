import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const source = readFileSync(new URL('./PacotesPdf.tsx', import.meta.url), 'utf8');

// Executa o componente real com transporte e ciclo de efeito controlados, sem HTTP/banco.
async function montar(status: number | Error, desmontar = false) {
  let state = false;
  let effect: () => (() => void);
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const compiledModule = { exports: {} as { default: () => unknown } };
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, {
    exports: compiledModule.exports,
    require: (name: string) => name.endsWith('.css') ? { default: {} } : name === 'react' ? {
      ...React,
      useState: () => [state, (next: boolean) => { state = next; }],
      useEffect: (callback: typeof effect) => { effect = callback; },
    } : require(name),
    AbortController,
    fetch: async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      if (status instanceof Error) throw status;
      return { ok: status >= 200 && status < 300 };
    },
  });
  const render = () => renderToStaticMarkup(React.createElement(compiledModule.exports.default));
  assert.equal(render(), '', 'Não deve oferecer link antes da confirmação de publicação');
  const cleanup = effect!();
  if (desmontar) cleanup();
  await new Promise((resolve) => setImmediate(resolve));
  const html = render();
  cleanup();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/fechamentos/tabela-pacotes');
  assert.equal(calls[0].options.method, 'HEAD');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.signal?.aborted, true);
  return html;
}

test('PDF publicado: visualizar em nova aba sem download forçado; download separado', async () => {
  const html = await montar(204);
  const links = html.match(/<a\b[^>]*>/g) ?? [];
  assert.equal(links.length, 2);
  assert.match(links[0], /href="\/api\/fechamentos\/tabela-pacotes"/);
  assert.match(links[0], /target="_blank"/);
  assert.match(links[0], /rel="noopener noreferrer"/);
  assert.doesNotMatch(links[0], /download/);
  assert.match(links[1], /\?download=1/);
  assert.match(links[1], /download="pacotes-e-precos.pdf"/);
  assert.match(html, /Ver pacotes e preços/);
  assert.match(html, /Baixar PDF/);
});

for (const status of [404, 503, new Error('offline')]) {
  test(`PDF ausente/indisponível (${status}): nenhum botão quebrado`, async () => {
    assert.equal(await montar(status), '');
  });
}

test('Resposta após desmontagem não habilita os links', async () => {
  assert.equal(await montar(204, true), '');
});
