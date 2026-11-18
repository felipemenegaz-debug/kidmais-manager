import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acharPersonagemProtegido } from './personagens-protegidos.ts';

test('reconhece personagens com caixa, acento e pontuação diferentes', () => {
  for (const [pedido, termo] of [
    ['Festa de POKEMON, com estrelas.', 'Pokémon'],
    ['Tunel da turma   da monica.', 'Turma da Mônica'],
    ['Um cartaz do HOMEM ARANHA.', 'Homem-Aranha'],
    ['Uma festa com (Minnie Mouse).', 'Minnie Mouse'],
    ['tema do Mario com cogumelos', 'Mario'],
    ['festa do mário e luigi', 'Mario'],
    ['festa do luigi', 'Luigi'],
    ['mario kart', 'Mario Kart'],
    ['Aventura de Mario Bros', 'Mario Bros'],
    ['Princesa peach', 'Princesa Peach'],
    ['Yoshi', 'Yoshi'],
    ['Bowser', 'Bowser'],
    ['Unicórnio da Barbie', 'Barbie'],
  ]) {
    assert.deepEqual(acharPersonagemProtegido(pedido), { termo, tipo: 'personagem' });
  }
});

test('identifica as marcas e devolve o tipo correspondente', () => {
  for (const termo of ['Disney', 'Pixar', 'Marvel', 'LEGO', 'Nickelodeon', 'Roblox', 'Minecraft']) {
    assert.deepEqual(acharPersonagemProtegido('Tema ' + termo.toLowerCase()), { termo, tipo: 'marca' });
  }
});

test('não casa trecho dentro de palavra ou número nem termos genéricos dos exemplos', () => {
  assert.equal(acharPersonagemProtegido('As flores colorem o jardim. Jardim com sonicidade, barbiesca e lego2.'), undefined);
  assert.equal(acharPersonagemProtegido('Uma pequena astronauta, sereia e dinossauro simpático.'), undefined);
  assert.equal(acharPersonagemProtegido('cinderela no castelo'), undefined);
  assert.equal(acharPersonagemProtegido(''), undefined);
});
