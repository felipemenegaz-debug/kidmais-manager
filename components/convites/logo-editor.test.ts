// Etapa 3 da logo do buffet (plano r15.1, §4–§6 e §9 "Editor"): regras puras da tela do buffet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TAMANHOS_LOGO, LUGARES_LOGO, moverLogo, passoDaTecla, arrastarLogo, anuncioPosicao, logoEfetiva, avisoOrigem,
  avisoSemNome, logoLigadaParaGerar, ESPERA_MOSTRAR_MS, PASSO_SETA, PASSO_SETA_SHIFT, limitarAoExibido, incorporarConfirmados,
  decidirLeitura, comLimite, chaveDaCaixa, TENTATIVAS_LEITURA_LOGO, LIMITE_LEITURA_LOGO_MS,
} from './logo-editor.ts';
import type { LogoLocal } from './logo-editor.ts';

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

test('r2 P3: depois de um canto, cada seta move o centro exibido (sem zona morta)', () => {
  const caixa = { width: 26, height: 10 };
  const canto = limitarAoExibido({ ...p, x: 0, y: 0, largura: 26 }, caixa);
  assert.deepEqual([canto.x, canto.y], [13, 5], 'canto gravado já no centro exibido');
  const direita = limitarAoExibido(moverLogo(canto, PASSO_SETA, 0), caixa);
  assert.equal(direita.x, 14, 'o primeiro toque já move');
  // Posição legada (x=0 gravado antes da r2): a seta parte do centro exibido.
  const legado = limitarAoExibido(moverLogo(limitarAoExibido({ ...p, x: 0, y: 50 }, caixa), PASSO_SETA, 0), caixa);
  assert.equal(legado.x, 14);
  const borda = limitarAoExibido(moverLogo(limitarAoExibido({ ...p, x: 100 }, caixa), PASSO_SETA_SHIFT, 0), caixa);
  assert.equal(borda.x, 87, 'empurrar além da borda não acumula');
  assert.equal(limitarAoExibido(p, null), p, 'sem caixa exibida fica como está');
  assert.equal(limitarAoExibido({ ...p, x: 0 }, { width: 7.333, height: 4 }).x, 3.67, 'centro arredondado a 2 casas');
  assert.equal(anuncioPosicao(canto), 'Logo a 13% da esquerda e 5% do topo.');
});

test('r2 P2: a base só recebe os campos confirmados depois do número já incorporado', () => {
  const base: LogoLocal & { extra: number } = { mostrar: true, posicoes: { a: { ...p, x: 10 } }, extra: 1 };
  const conf = { n: 3, mostrar: { valor: false, n: 2 }, posicoes: { a: { valor: { ...p, x: 40 }, n: 3 }, b: { valor: { ...p, arteId: 'b' }, n: 1 } } };
  const r = incorporarConfirmados(base, conf, 1);
  assert.equal(r.mostrar, false);
  assert.equal(r.posicoes.a.x, 40);
  assert.equal(r.posicoes.a.origem, 'buffet');
  assert.equal(r.posicoes.b, undefined, 'confirmação já incorporada não volta');
  assert.equal(r.extra, 1, 'preserva os outros campos da base');
  assert.equal(incorporarConfirmados(base, conf, 3), base, 'nada novo: mesma base');
  assert.equal(incorporarConfirmados(base, conf, 2).mostrar, true, 'mostrar já incorporado (n 2) não volta');
  // Intenção pendente que a fila descartou não está em `confirmados`: a base não muda.
  assert.deepEqual(incorporarConfirmados(base, { n: 0, posicoes: {} }, 0), base);
});

test('r3 P2: leitura só vale com a fila vazia e sem mudança durante ela; nunca mistura leituras', () => {
  assert.equal(decidirLeitura({ pendente: false, marcaAntes: 4, marcaAgora: 4 }), 'aplicar');
  assert.equal(decidirLeitura({ pendente: true, marcaAntes: 4, marcaAgora: 4 }), 'esperar', 'comando pendente: espera esvaziar');
  assert.equal(decidirLeitura({ pendente: true, marcaAntes: 4, marcaAgora: 5 }), 'esperar');
  assert.equal(decidirLeitura({ pendente: false, marcaAntes: 4, marcaAgora: 5 }), 'reler', 'confirmação chegou antes do JSON: lê de novo');
  assert.equal(TENTATIVAS_LEITURA_LOGO, 2, 'uma nova tentativa, depois para');
  assert.ok(LIMITE_LEITURA_LOGO_MS > 0 && LIMITE_LEITURA_LOGO_MS <= 15000);
});

test('r3 P2: comLimite rejeita no tempo e limpa o relógio nos dois caminhos', async () => {
  const ativos = new Set<number>(); let id = 0; const pendentes = new Map<number, () => void>();
  const relogio = {
    set: (fn: () => void) => { const i = ++id; ativos.add(i); pendentes.set(i, fn); return i; },
    clear: (i: unknown) => { ativos.delete(i as number); pendentes.delete(i as number); },
  };
  // Relógio padrão (setTimeout real, sem "this" de outro objeto): resolve e rejeita no tempo.
  assert.equal(await comLimite(Promise.resolve(1), 50), 1);
  await assert.rejects(comLimite(new Promise<number>(() => undefined), 5), /Tempo esgotado/);
  assert.equal(await comLimite(Promise.resolve(7), 10, relogio), 7);
  assert.equal(ativos.size, 0);
  await assert.rejects(comLimite(Promise.reject(new Error('403')), 10, relogio), /403/);
  assert.equal(ativos.size, 0);
  const nunca = comLimite(new Promise<number>(() => undefined), 10, relogio);
  const [i, fn] = [...pendentes][0]; ativos.delete(i); fn();
  await assert.rejects(nunca, /Tempo esgotado/);
});

test('r3 P3: a chave da caixa muda com arte, largura e fundo, não com a posição', () => {
  const outroLugar = { ...p, x: 10, y: 90 };
  assert.equal(chaveDaCaixa(p), chaveDaCaixa(outroLugar));
  assert.notEqual(chaveDaCaixa(p), chaveDaCaixa({ ...p, largura: 24 }));
  assert.notEqual(chaveDaCaixa(p), chaveDaCaixa({ ...p, fundo: true }));
  assert.notEqual(chaveDaCaixa(p), chaveDaCaixa({ ...p, arteId: 'b' }));
});
