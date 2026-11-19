import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { faseGeracao, formatarDuracao, LIMITE_PROVEDOR_SEGUNDOS, TEXTO_FASE } from './progresso-geracao.ts';

test('fases: criando até o prazo do provedor, depois conferindo; sem início conhecido, acompanhando', () => {
  assert.equal(faseGeracao(0), 'criando');
  assert.equal(faseGeracao(LIMITE_PROVEDOR_SEGUNDOS - 1), 'criando');
  assert.equal(faseGeracao(LIMITE_PROVEDOR_SEGUNDOS), 'conferindo');
  assert.equal(faseGeracao(null), 'acompanhando');
});

test('duração em m:ss', () => {
  assert.equal(formatarDuracao(0), '0:00');
  assert.equal(formatarDuracao(65), '1:05');
  assert.equal(formatarDuracao(120), '2:00');
  assert.equal(formatarDuracao(-3), '0:00');
});

test('o prazo mostrado é o mesmo do código que chama o provedor', () => {
  const imagem = readFileSync(new URL('./imagem.ts', import.meta.url), 'utf8');
  assert.match(imagem, new RegExp(`AbortSignal\\.timeout\\(${LIMITE_PROVEDOR_SEGUNDOS}_000\\)`));
  assert.match(TEXTO_FASE.criando, /2 minutos/);
  for (const texto of Object.values(TEXTO_FASE)) assert.doesNotMatch(texto, /%/, 'sem porcentagem');
});
