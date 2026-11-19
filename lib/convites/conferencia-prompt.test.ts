import test from 'node:test';
import assert from 'node:assert/strict';
import { conflitoDeEstilo, conferirPrompt, alinharPrompt, estiloDoPedido } from './conferencia-prompt.ts';
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

test('avisa cada estilo específico que conflita com o seletor', () => {
  for (const estilo of ['aquarela', 'realista', 'fotografia', '2D', 'pixel', 'mangá', 'anime', 'lápis']) {
    assert.equal(conflitoDeEstilo(`Cena em ${estilo.toUpperCase()}.`, 'cartoon3d'), estilo);
  }
  assert.equal(conflitoDeEstilo('Arte em 3D com balões.', 'cartoon2d'), '3D');
});

test('respeita estilos compatíveis, palavras inteiras e a opção do pedido', () => {
  assert.equal(conflitoDeEstilo('desenho de dinossauros na floresta', 'cartoon3d'), undefined);
  assert.equal(conflitoDeEstilo('com um desenho 3D', 'cartoon3d'), undefined);
  assert.equal(conflitoDeEstilo('desenho 3D', 'cartoon2d'), 'desenho 3D');
  assert.equal(conflitoDeEstilo('desenho 2D', 'cartoon3d'), 'desenho 2D');
  assert.equal(conflitoDeEstilo('Desenho 2D com estrelas', 'cartoon2d'), undefined);
  assert.equal(conflitoDeEstilo('Fotografia realista', 'realista'), undefined);
  assert.equal(conflitoDeEstilo('Pixelada, megadesenho, 123d', 'cartoon3d'), undefined);
  assert.equal(conflitoDeEstilo('Desenho em LAPIS, estilo manga', 'pedido'), undefined);
  assert.equal(conflitoDeEstilo('Desenho 2D em LAPIS', 'cartoon2d'), 'lápis');
});

test('estilo do pedido: opção do seletor quando existe; senão, O que eu escrevi', () => {
  assert.deepEqual(estiloDoPedido('Aventura de videogame retrô em pixel art.'), { termo: 'pixel', estilo: 'pedido' });
  assert.deepEqual(estiloDoPedido('Floresta em aquarela.'), { termo: 'aquarela', estilo: 'pedido' });
  assert.deepEqual(estiloDoPedido('Desenho 2D com estrelas.'), { termo: 'desenho 2D', estilo: 'cartoon2d' });
  assert.deepEqual(estiloDoPedido('Fotografia de um jardim.'), { termo: 'fotografia', estilo: 'realista' });
  assert.equal(estiloDoPedido('Cena em 3D com balões.'), undefined, 'o padrão já é cartoon 3D');
  assert.equal(estiloDoPedido('Pixelada, megadesenho, 123d'), undefined);
});
