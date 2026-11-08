import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import * as roteamento from '../../lib/enderecos/roteamento.ts';
import * as hosts from '../../lib/marketing/dominios/hosts.ts';
import * as contratoUrl from './contrato-url.ts';
import { pareceListaDeContratos } from './contrato-url.ts';

/**
 * Sonda do proxy real com o `NextRequest` do Next: o link antigo da lista de contratos nunca leva o termo a outro host,
 * em nenhum salto, nem pelo caminho codificado ou com barras a mais. Cada salto é seguido como o navegador faria.
 */
const exigir = createRequire(import.meta.url);
const servidor = exigir('next/server');
const { NextRequest } = servidor;

function carregarProxy(): (pedido: unknown) => Response {
  const fonte = ts.transpileModule(readFileSync('proxy.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const deps: Record<string, unknown> = {
    'next/server': servidor,
    './lib/enderecos/roteamento': roteamento,
    './lib/marketing/dominios/hosts': hosts,
    './components/admin/contrato-url': contratoUrl,
  };
  const modulo = { exports: {} as Record<string, unknown> };
  new Function('require', 'module', 'exports', fonte)((nome: string) => {
    if (!(nome in deps)) throw new Error(`dependência inesperada do proxy: ${nome}`);
    return deps[nome];
  }, modulo, modulo.exports);
  return modulo.exports.proxy as (pedido: unknown) => Response;
}
const proxy = carregarProxy();

const A = 'https://manager.kidmaisfestas.com';
const N = 'https://iafest.demerzellabs.com.br';
const base = { ENDERECOS_ORIGEM_ANTIGA: A, ENDERECOS_ORIGEM_NOVA: N };
const MODOS: Array<[string, Record<string, string>, string]> = [
  ['ATIVA', { ...base, ENDERECOS_MODO: 'ATIVA', ADMIN_AUTH_ORIGIN: N }, A],
  ['PREPARACAO', { ...base, ENDERECOS_MODO: 'PREPARACAO', ADMIN_AUTH_ORIGIN: A }, N],
  ['REVERSAO', { ...base, ENDERECOS_MODO: 'REVERSAO', ADMIN_AUTH_ORIGIN: A }, N],
  ['sem modo', { ADMIN_AUTH_ORIGIN: A }, A],
];
const CHAVES = ['ENDERECOS_MODO', 'ENDERECOS_ORIGEM_ANTIGA', 'ENDERECOS_ORIGEM_NOVA', 'ADMIN_AUTH_ORIGIN', 'MARKETING_DOMINIOS_PERSONALIZADOS', 'KIDMAIS_DEPLOY_ENV'];

function comAmbiente<T>(env: Record<string, string>, fn: () => T): T {
  const antes = Object.fromEntries(CHAVES.map((k) => [k, process.env[k]]));
  for (const k of CHAVES) delete process.env[k];
  Object.assign(process.env, env);
  try { return fn(); } finally {
    for (const k of CHAVES) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
  }
}

type Salto = { url: string; status: number; location: string | null; cache: string | null };
/** Segue os redirecionamentos do proxy, como o navegador, até a resposta que entrega a aplicação (ou 5 saltos). */
function seguir(inicio: string, metodo = 'GET'): Salto[] {
  const saltos: Salto[] = [];
  let url = inicio;
  for (let i = 0; i < 5; i++) {
    const alvo = new URL(url);
    const resposta = proxy(new NextRequest(url, { method: metodo, headers: { host: alvo.host } }));
    const location = resposta.headers.get('location');
    saltos.push({ url, status: resposta.status, location, cache: resposta.headers.get('cache-control') });
    if (!location || resposta.status < 300 || resposta.status >= 400) return saltos;
    url = new URL(location, url).toString();
  }
  throw new Error(`mais de 5 saltos a partir de ${inicio}`);
}

const TERMO = 'segundo';
const VARIANTES = [
  '/admin/contratos', '/admin/%63ontratos', '/admin/%2563ontratos', '/admin/%252563ontratos',
  '/admin//contratos', '//admin/contratos', '/ADMIN/Contratos', '/admin/contratos/', '/admin/contratos//',
  '/admin/%2e/contratos', '/admin/x/%2e%2e/contratos', '/admin%2fcontratos', '/admin%5ccontratos', '/admin/contratos%2f',
  '/%61dmin/contratos', '/admin/contrato%73', '/admin/c%6Fntratos', '/admin/%zz/../contratos',
];

test('pareceListaDeContratos reconhece as variantes que o Next resolve para a lista, e só elas', () => {
  for (const v of VARIANTES) assert.equal(pareceListaDeContratos(v), true, v);
  for (const v of ['/admin/contratos/importar', '/admin/contratosx', '/admin/clientes', '/admin', '/admin/ajuda/contratos', '/api/admin/contratos/lista'])
    assert.equal(pareceListaDeContratos(v), false, v);
});

for (const [nome, env, origem] of MODOS) {
  for (const metodo of ['GET', 'HEAD']) {
    test(`proxy, ${nome}, ${metodo}: o termo do link antigo nunca chega a outro host, em nenhuma variante do caminho`, () => {
      comAmbiente(env, () => {
        for (const caminho of VARIANTES) {
          const inicio = `${origem}${caminho}?filtro=todas&busca=${TERMO}&b%75sca=outro&contratoId=x`;
          const saltos = seguir(inicio, metodo);
          const ctx = `${caminho}: ${JSON.stringify(saltos)}`;
          for (const s of saltos) {
            if (!s.location) continue;
            const destino = new URL(s.location, s.url);
            if (destino.origin !== new URL(s.url).origin) {
              assert.equal(destino.searchParams.has('busca'), false, `busca num Location para outro host: ${ctx}`);
              assert.ok(!s.location.includes(TERMO) && !s.location.includes('outro'), `termo num Location para outro host: ${ctx}`);
            }
          }
          // O primeiro salto tira o termo na mesma origem, sem cache, e mantém o resto da URL.
          const primeiro = saltos[0];
          assert.equal(primeiro.status, 307, `primeiro salto não é o 307 da limpeza: ${ctx}`);
          const limpo = new URL(primeiro.location!, primeiro.url);
          assert.equal(limpo.origin, new URL(inicio).origin, `primeiro salto sai da origem: ${ctx}`);
          assert.equal(limpo.pathname, '/admin/contratos', `primeiro salto fora do caminho canônico: ${ctx}`);
          assert.equal(limpo.search, '?filtro=todas&contratoId=x', `primeiro salto perde o resto da URL: ${ctx}`);
          assert.equal(primeiro.cache, 'no-store', `primeiro salto sem no-store: ${ctx}`);
          // Nenhum salto depois do primeiro volta a ter o termo, em host nenhum.
          for (const s of saltos.slice(1)) assert.ok(!s.url.includes(TERMO) && !(s.location ?? '').includes(TERMO), ctx);
          assert.equal(saltos.at(-1)!.location, null, `termina entregando a aplicação: ${ctx}`);
        }
      });
    });
  }
}

test('proxy: sem o termo, a lista segue a troca de host de sempre (nenhum salto a mais)', () => {
  comAmbiente(MODOS[0][1], () => {
    const saltos = seguir(`${A}/admin/contratos?filtro=todas`);
    assert.equal(saltos.length, 2);
    assert.equal(saltos[0].location, `${N}/admin/contratos?filtro=todas`);
  });
});
