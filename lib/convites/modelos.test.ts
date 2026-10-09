import assert from 'node:assert/strict';
import test from 'node:test';
import { conteudoSchema, inicioConteudo } from './domain.ts';
import { comporTexto, modelosBiblioteca, svgModelo } from './modelos.ts';

const c = { ...inicioConteudo({}), nome: 'Ana', data: '2027-04-20', horario: '15:00', local: 'Buffet', endereco: 'Rua das Flores' };
test('modelos podem ser publicados sem exigir arte paga ou mudar conteúdo antigo', () => {
  for (const tema of [...modelosBiblioteca, 'celebrar', 'jardim', 'espaco']) {
    assert.equal(conteudoSchema.safeParse({ ...c, tema }).success, true);
  }
  assert.equal(conteudoSchema.safeParse({ ...c, tema: 'inexistente' }).success, false);
});
test('texto e URLs não podem injetar marcação no SVG público/exportado', () => {
  const svg = svgModelo({ ...c, tema: 'arco', nome: '<script>&"' }, { arte: '"/><script>alert(1)</script>' });
  assert(!svg.includes('<script>'));
  assert(svg.includes('&lt;script&gt;'));
  assert(!svg.includes('foreignObject'));
});
test('nomes longos e palavras sem espaços cabem nos blocos sem descartar letras', () => {
  for (const texto of ['Maria Eduarda Aparecida de Albuquerque e Vasconcelos', 'W'.repeat(80)]) {
    const bloco = comporTexto(texto, 740, 295, 166);
    assert(bloco.altura <= 295);
    assert.equal(bloco.linhas.join('').replaceAll(' ', ''), texto.replaceAll(' ', ''));
  }
  const mensagem = comporTexto('Vamos comemorar juntos! '.repeat(17).slice(0, 400), 740, 250, 35);
  assert(mensagem.altura <= 250);
});
test('bases neutras não incluem planetas; cores próprias e imagens seguem escapadas', () => {
  for (const tema of ['arco', 'ondulada'] as const) assert(!svgModelo({ ...c, tema }).includes('<image'));
  const svg = svgModelo({ ...c, tema: 'planetas' });
  assert.equal((svg.match(/<image /g) ?? []).length, 3);
  assert(svg.includes('UMA AVENTURA ESPACIAL'));
});
