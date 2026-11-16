import assert from 'node:assert/strict';
import test from 'node:test';
import { medidasFaixaLogo } from './faixa-logo.ts';

test('faixa: ~12% da altura da arte, logo centrada e sem distorcer', () => {
  const m = medidasFaixaLogo(1080, 1440, 400, 200)!;
  assert.equal(m.faixa, 173); assert.equal(m.alturaTotal, 1613);
  assert.ok(m.altura <= Math.round(m.faixa * 0.6) && m.largura <= 432);
  assert.ok(Math.abs(m.largura / m.altura - 2) < 0.02, 'proporção preservada');
  assert.equal(m.x, Math.round((1080 - m.largura) / 2));
  assert.ok(m.y >= 1440 && m.y + m.altura <= 1613, 'logo inteira dentro da faixa, nunca sobre a arte');
});

test('faixa: logo muito larga é limitada pela largura; arte baixa tem faixa mínima', () => {
  const larga = medidasFaixaLogo(1080, 1800, 3000, 100)!;
  assert.equal(larga.largura, 432); assert.equal(larga.faixa, 216);
  const baixa = medidasFaixaLogo(600, 400, 50, 50)!;
  assert.equal(baixa.faixa, 96); assert.equal(baixa.alturaTotal, 496);
});

test('faixa: medidas inválidas não criam faixa', () => {
  const casos: [number, number, number, number][] = [[1080, 1440, 0, 10], [1080, 1440, 10, Number.NaN], [0, 1440, 10, 10]];
  for (const [a, b, c, d] of casos) assert.equal(medidasFaixaLogo(a, b, c, d), null);
});
