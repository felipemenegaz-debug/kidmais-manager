import assert from 'node:assert/strict';
import test from 'node:test';
import { conteudoSchema, inicioConteudo, rascunhoSchema } from './domain.ts';
import { contraste, enquadramento, paletaDosPixels, temaVisual, tintaLegivel, visualPadrao } from './visual.ts';
import { csvPresencas, resumoPresencas } from './presencas.ts';

test('convites antigos mantêm tema e novos visuais aceitam somente valores seguros', () => {
  const legado = inicioConteudo({});
  assert.equal(rascunhoSchema.safeParse(legado).success, true);
  assert.equal(temaVisual(legado).fundo, '#fff3df');
  const visual = { ...visualPadrao, modo: 'completa' as const, cores: { fundo: '#ffddaa', tinta: '#ffddaa', destaque: '#aa00bb' } };
  assert.equal(rascunhoSchema.safeParse({ ...legado, visual }).success, true);
  for (const mal of [{ ...visual, x: -1 }, { ...visual, y: 101 }, { ...visual, x: Infinity }, { ...visual, modo: 'html' }, { ...visual, cores: { ...visual.cores, fundo: 'url(https://example.com)' } }]) {
    assert.equal(conteudoSchema.shape.visual.safeParse(mal).success, false);
  }
  const seguro = temaVisual({ ...legado, visual });
  assert(contraste(seguro.fundo, seguro.tinta) >= 4.5);
});

test('cores garantem contraste de texto e botões mesmo nos fundos intermediários', () => {
  for (const fundo of ['#ffffff', '#000000', '#777777', '#888888', '#ff0066', '#0000ff', '#bada55']) {
    assert(contraste(fundo, tintaLegivel(fundo, fundo)) >= 4.5);
  }
});

test('paleta ignora transparência e branco predominante quando há cor cromática', () => {
  const azul = [0, 50, 220, 255], pixels = [...Array(20).fill([255, 255, 255, 255]).flat(), ...Array(10).fill(azul).flat(), ...Array(50).fill([255, 0, 0, 0]).flat()];
  const cores = paletaDosPixels(pixels);
  assert.equal(cores.destaque, '#0032dc'); assert(contraste(cores.fundo, cores.tinta) >= 4.5);
  assert.throws(() => paletaDosPixels([0, 0, 0, 0]), /cores visíveis/);
});

test('recorte preserva proporção e posições iguais às de object-position', () => {
  const conter = enquadramento(1600, 900, 1080, 1440);
  assert.equal(conter.largura, 1080); assert.equal(conter.altura, 607.5); assert.equal(conter.y, 416.25);
  const esquerda = enquadramento(1600, 900, 1080, 1440, { ...visualPadrao, ajuste: 'preencher', x: 0 });
  const direita = enquadramento(1600, 900, 1080, 1440, { ...visualPadrao, ajuste: 'preencher', x: 100 });
  assert.equal(Math.abs(esquerda.x), 0); assert.equal(direita.x, -1480); assert.equal(direita.altura, 1440);
  const vertical = enquadramento(400, 1200, 1080, 540, { ...visualPadrao, ajuste: 'preencher', y: 100 });
  assert.equal(vertical.y, -2700);
});

test('resumo não conta recusas e distingue acima, abaixo e contrato indisponível', () => {
  const respostas = [{ nome: 'Sim', presenca: true, adultos: 2, criancas: 3 }, { nome: 'Não', presenca: false, adultos: 9, criancas: 9 }];
  assert.deepEqual(resumoPresencas(respostas, 4), { adultos: 2, criancas: 3, total: 5, familias: 1, recusas: 1, diferenca: 1 });
  assert.equal(resumoPresencas(respostas, 10).diferenca, -5);
  assert.equal(resumoPresencas(respostas, null).diferenca, null);
});

test('CSV neutraliza fórmulas, escapa aspas e não exporta contagem de recusas', () => {
  const csv = csvPresencas([{ nome: '  =CMD("teste")', presenca: false, adultos: 7, criancas: 8 }, { nome: 'Família; Souza', presenca: true, adultos: 2, criancas: 1 }]);
  assert(csv.startsWith('\ufeff')); assert(csv.includes('"\'  =CMD(""teste"")";"Não vai";"0";"0";"0"'));
  assert(csv.includes('"Família; Souza";"Confirmada";"2";"1";"3"'));
});
