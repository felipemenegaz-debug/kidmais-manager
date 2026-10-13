import test from 'node:test';
import assert from 'node:assert/strict';
import { conferirPrompt, alinharPrompt } from './conferencia-prompt.ts';
const campos = { nome: 'Mariana', idade: '10 anos' };
test('repetição equivalente e ausência não geram conflito', () => {
  for (const p of ['Tema azul e dourado', 'aniversário da mariana 10 anos', 'Mariana 10 anos, cartoon']) assert.equal(conferirPrompt(p, campos).conflito, false);
  assert.equal(conferirPrompt('Convite do tema astronauta do Miguel 5 anos na Kidmais', {nome:'Miguel',idade:'5 anos'}).conflito, false);
});
test('divergência, múltiplas idades e escolha preservam instruções visuais', () => {
  const p = 'aniversário da Maria 9 anos, azul e dourado';
  assert.equal(conferirPrompt(p, campos).conflito, true);
  assert.equal(alinharPrompt(p, campos), 'aniversário da Mariana 10 anos, azul e dourado');
  assert.equal(conferirPrompt(alinharPrompt(p, campos),campos).conflito,false);
  assert.equal(conferirPrompt('Mariana 9 anos e 10 anos',campos).ambiguo,true);
  const duplo = alinharPrompt('aniversário da Maria 9 anos e aniversário da Maria Clara 8 anos, azul',campos);
  assert.equal(conferirPrompt(duplo,campos).conflito,false);
  assert.equal(alinharPrompt('aniversário da Ana 9 anos, banana dourada',campos),'aniversário da Mariana 10 anos, banana dourada');
});
