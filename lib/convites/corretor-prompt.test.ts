import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { criarDicionario } from './dicionario-prompt.ts';
import { palavraNoPrompt, substituirPalavra } from './palavra-prompt.ts';

// Corretor local: dicionário estático servido pelo próprio app; o prompt nunca sai do navegador.
const pasta = path.join(process.cwd(), 'public/dicionarios/pt-BR');

test('corretor: dicionário pt-BR e licença acompanham o build público', async () => {
  const licenca = await readFile(path.join(pasta, 'license'), 'utf8');
  assert.match(licenca, /LGPL|Lesser General Public License/); assert.match(licenca, /Mozilla Public License/);
  const corrigir = criarDicionario(await readFile(path.join(pasta, 'index.dic'), 'utf8'));
  assert.deepEqual(corrigir('festa'), { correta: true, sugestoes: [] });
  const acento = corrigir('aniversario');
  assert.equal(acento.correta, false); assert.ok(acento.sugestoes.includes('aniversário'), acento.sugestoes.join());
  const digitacao = corrigir('dinossaruo');
  assert.equal(digitacao.correta, false); assert.ok(digitacao.sugestoes.includes('dinossauro'), digitacao.sugestoes.join());
});

test('corretor: localiza a palavra no cursor e só aplica a sugestão escolhida no texto original', () => {
  const texto = 'Festa de aniversario com dinossauros';
  const trecho = palavraNoPrompt(texto, 12);
  assert.deepEqual(trecho, { palavra: 'aniversario', inicio: 9, fim: 20 });
  assert.equal(substituirPalavra(texto, trecho!, 'aniversário'), 'Festa de aniversário com dinossauros');
  assert.equal(substituirPalavra('FESTA', { palavra: 'FESTA', inicio: 0, fim: 5 }, 'festa'), 'FESTA');
  assert.equal(substituirPalavra('Aniversario', { palavra: 'Aniversario', inicio: 0, fim: 11 }, 'aniversário'), 'Aniversário');
  // Resposta atrasada não sobrescreve texto já editado.
  assert.equal(substituirPalavra('Festa editada', trecho!, 'aniversário'), 'Festa editada');
  assert.equal(palavraNoPrompt('123 !!', 1), null);
});
