import assert from 'node:assert/strict';
import test from 'node:test';
import { conteudoSchema, inicioConteudo } from './domain.ts';
import { baseNeutra, basesNeutras, comporTexto, modelosBiblioteca, modelosComFoto, svgModelo } from './modelos.ts';

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
  for (const tema of basesNeutras) {
    assert(baseNeutra(tema));
    assert(!svgModelo({ ...c, tema }).includes('<image'));
    assert(svgModelo({ ...c, tema }, { arte: '/foto.webp' }).includes('href="/foto.webp"'));
  }
  const svg = svgModelo({ ...c, tema: 'planetas' });
  assert.equal((svg.match(/<image /g) ?? []).length, 3);
  assert(svg.includes('UMA AVENTURA ESPACIAL'));
});
test('a descrição acessível do convite inclui os dados da festa', () => {
  const svg = svgModelo({ ...c, tema: 'aquarela', mensagem: 'Você está convidado!', idade: '5 anos' });
  const descricao = svg.match(/aria-label="([^"]+)"/)?.[1];
  for (const texto of ['Ana', '5 anos', 'Você está convidado!', '2027-04-20', '15:00', 'Buffet', 'Rua das Flores']) assert(descricao?.includes(texto));
});
test('foto em destaque preserva a imagem inteira e substitui a indicação de envio', () => {
  for (const tema of modelosComFoto) {
    assert(svgModelo({ ...c, tema }).includes('Sua foto aqui'));
    const svg = svgModelo({ ...c, tema }, { arte: '/foto.webp?nome=a&b=2' });
    assert(!svg.includes('Sua foto aqui'));
    assert(svg.includes('href="/foto.webp?nome=a&amp;b=2"'));
    assert(svg.includes('preserveAspectRatio="xMidYMid meet"'));
    assert.equal((svg.match(/<image /g) ?? []).length, 1);
    for (const valor of [c.nome, c.local, c.endereco]) assert(svg.includes(valor));
  }
  for (const [valor, largura, altura, tamanho] of [['W'.repeat(80), 740, 155, 110], ['Mensagem '.repeat(45).slice(0, 400), 740, 155, 33]] as const) {
    const bloco = comporTexto(valor, largura, altura, tamanho);
    assert(bloco.altura <= altura);
    assert.equal(bloco.linhas.join('').replaceAll(' ', ''), valor.trim().replaceAll(' ', ''));
  }
});
