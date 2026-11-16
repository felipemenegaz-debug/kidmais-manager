// Etapa 3 da logo do buffet (plano r15.1, §4–§6 e §9 "Editor"): regras puras da tela do buffet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TAMANHOS_LOGO, LUGARES_LOGO, moverLogo, passoDaTecla, arrastarLogo, anuncioPosicao, logoEfetiva, avisoOrigem,
  avisoSemNome, logoLigadaParaGerar, ESPERA_MOSTRAR_MS, PASSO_SETA, PASSO_SETA_SHIFT,
} from './logo-editor.ts';

const p = { modo: 'sobre' as const, arteId: 'a', x: 50, y: 50, largura: 18, fundo: false };

test('tamanho M é a largura sugerida da geometria', () => {
  const fonte = readFileSync(new URL('../../lib/convites/posicao-logo.ts', import.meta.url), 'utf8');
  const sugerida = Number(/export const LARGURA_SUGERIDA = (\d+)/.exec(fonte)?.[1]);
  assert.equal(TAMANHOS_LOGO.find(t => t[0] === 'M')?.[2], sugerida);
  for (const [, , v] of TAMANHOS_LOGO) assert.ok(v >= 8 && v <= 40, 'dentro do schema 8–40');
});

test('9 lugares cobrem cantos, meios e centro', () => {
  assert.equal(LUGARES_LOGO.length, 9);
  assert.deepEqual(new Set(LUGARES_LOGO.map(l => `${l.x},${l.y}`)).size, 9);
});

test('mover, setas e arraste ficam dentro de 0–100', () => {
  assert.deepEqual(moverLogo(p, -80, 70), { ...p, x: 0, y: 100 });
  assert.deepEqual(moverLogo(p, 0.333, 0), { ...p, x: 50.33, y: 50 });
  assert.deepEqual(passoDaTecla('ArrowLeft', false), { dx: -PASSO_SETA, dy: 0 });
  assert.deepEqual(passoDaTecla('ArrowDown', true), { dx: 0, dy: PASSO_SETA_SHIFT });
  assert.equal(passoDaTecla('Enter', false), null);
  assert.deepEqual(arrastarLogo(p, 100, -50, 400, 500), { ...p, x: 75, y: 40 });
  assert.equal(arrastarLogo(p, 10, 10, 0, 500), p, 'caixa sem tamanho não move');
  assert.equal(anuncioPosicao({ x: 12.6, y: 99.4 }), 'Logo a 13% da esquerda e 99% do topo.');
});

test('a intenção da fila vale por cima do gravado e vira origem buffet', () => {
  const gravada = { mostrar: true, posicoes: { a: { ...p, origem: 'reservada' as const }, b: { ...p, arteId: 'b', origem: 'sugerida' as const } } };
  assert.equal(logoEfetiva(gravada, null), gravada);
  const e = logoEfetiva(gravada, { mostrar: false, posicoes: { a: { ...p, x: 10 } } });
  assert.equal(e.mostrar, false);
  assert.equal(e.posicoes.a.origem, 'buffet'); assert.equal(e.posicoes.a.x, 10);
  assert.equal(e.posicoes.b.origem, 'sugerida', 'outra arte fica como estava');
  assert.equal(logoEfetiva(gravada, { posicoes: {} }).mostrar, true, 'sem mostrar pendente vale o gravado');
});

test('aviso de cada origem; buffet sem aviso', () => {
  for (const o of ['reservada', 'sugerida', 'faixa'] as const) assert.ok(avisoOrigem(o));
  assert.notEqual(avisoOrigem('reservada'), avisoOrigem('sugerida'));
  assert.equal(avisoOrigem('buffet'), null); assert.equal(avisoOrigem(undefined), null);
});

test('aviso ao desligar confere prévia e publicado (r15/r15.1)', () => {
  const duas = avisoSemNome('A', 'B', ['A', 'B']);
  assert.match(duas!, /Esta arte e o convite publicado/, 'A e B diferentes, as duas marcadas: texto das duas');
  assert.match(avisoSemNome('A', 'A', ['A'])!, /Esta arte e o convite publicado/);
  assert.match(avisoSemNome('A', null, ['A'])!, /^Esta arte foi gerada/, 'publicado nulo: só a prévia');
  assert.equal(avisoSemNome('B', null, ['A']), null);
  assert.match(avisoSemNome('B', 'A', ['A'])!, /^O convite publicado/, 'prévia sem marca, publicado marcado');
  assert.match(avisoSemNome('A', 'B', ['A'])!, /^Esta arte foi gerada/);
  assert.equal(avisoSemNome('A', 'B', []), null); assert.equal(avisoSemNome('A', 'B', undefined), null);
});

test('gerar: espera o mostrar só quando há espera; erro ou tempo bloqueiam', async () => {
  assert.equal(await logoLigadaParaGerar(null, () => true), true, 'sem fila (família/laboratório): valor da tela');
  let avisou = 0; let ms = 0;
  const fila = (r: 'ok' | 'tempo' | 'erro', atraso: boolean) => ({
    aguardarMostrar(t: number) { ms = t; return atraso ? new Promise<typeof r>(res => setTimeout(() => res(r), 5)) : Promise.resolve(r); },
  });
  assert.equal(await logoLigadaParaGerar(fila('ok', false), () => false, () => avisou++), false);
  assert.equal(avisou, 0, 'nada pendente: sai na hora, sem aviso'); assert.equal(ms, ESPERA_MOSTRAR_MS);
  assert.equal(await logoLigadaParaGerar(fila('ok', true), () => true, () => avisou++), true);
  assert.equal(avisou, 1, 'esperou: avisa uma vez');
  assert.equal(await logoLigadaParaGerar(fila('tempo', true), () => true), null);
  assert.equal(await logoLigadaParaGerar(fila('erro', false), () => true), null);
  let lido = 0;
  await logoLigadaParaGerar(fila('ok', true), () => { lido++; return true; });
  assert.equal(lido, 1, 'valor lido depois da espera');
});
