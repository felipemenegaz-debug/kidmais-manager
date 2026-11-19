import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acharPersonagemProtegido, termos } from './personagens-protegidos.ts';
import { sugestaoOriginal } from './sugestao-original.ts';

const normalizar = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

test('todo termo protegido tem um pedido próprio, sem cair no genérico', () => {
  const generico = sugestaoOriginal({ termo: 'termo-inexistente', tipo: 'personagem' });
  for (const mencao of termos) {
    const pedido = sugestaoOriginal(mencao);
    assert.notEqual(pedido, generico, `${mencao.termo} sem sugestão própria`);
    assert.ok(pedido.length >= 40 && pedido.length <= 400, `${mencao.termo}: tamanho ${pedido.length}`);
  }
});

test('a sugestão é original: não cita nenhum termo protegido e passa pela própria conferência', () => {
  for (const mencao of termos) {
    const pedido = sugestaoOriginal(mencao);
    assert.equal(acharPersonagemProtegido(pedido), undefined, `${mencao.termo}: "${pedido}"`);
    assert.ok(!normalizar(pedido).includes(normalizar(mencao.termo)), `${mencao.termo} aparece na sugestão`);
  }
});

test('o exemplo de Felipe (Super Mário, pixelado) recebe o clima de videogame retrô', () => {
  const mencao = acharPersonagemProtegido('Convite com o cenário inspirado em Super Mário, ambiente pixelado com moedas, canos verdes, etc.');
  assert.deepEqual(mencao, { termo: 'Super Mario', tipo: 'personagem' });
  const pedido = sugestaoOriginal(mencao!);
  assert.match(pedido, /pixel art/);
  assert.match(pedido, /moedas douradas/);
  assert.doesNotMatch(normalizar(pedido), /cano|cogumelo|encanador/);
});

test('termo desconhecido recebe um pedido genérico não vazio', () => {
  assert.match(sugestaoOriginal({ termo: 'Outro', tipo: 'marca' }), /festa infantil/);
});
