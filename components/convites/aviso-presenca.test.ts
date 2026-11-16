import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { carregarModulo } from '../../lib/acessos/teste-carregador.ts';

// R-5 (revisão do Astra, 03/11): a página pública informa o tratamento antes de coletar a confirmação de presença.
const { default: AvisoPresenca } = carregarModulo('components/convites/AvisoPresenca.tsx', {}) as { default: ComponentType<{ buffet: string }> };

test('aviso do RSVP: identifica o buffet, a finalidade, quem vê, pede adulto responsável e leva ao Aviso de privacidade', () => {
  const html = renderToStaticMarkup(createElement(AvisoPresenca, { buffet: 'Buffet Exemplo' }));
  assert.match(html, /O buffet Buffet Exemplo é o responsável pelos dados desta confirmação/);
  assert.match(html, /só para organizar a festa/);
  assert.match(html, /vista pelo buffet e pelo organizador/);
  assert.match(html, /feita por um adulto responsável/);
  assert.match(html, /href="\/privacidade#tratamento-de-dados"/);
  assert.doesNotMatch(html, /data de nascimento|CPF|documento/i, 'não pede dados da criança nem documentos');
});

test('aviso do RSVP: fica antes dos campos, no mesmo formulário do link do convite e do link da família', () => {
  const fonte = readFileSync('components/convites/ConvitePublico.tsx', 'utf8');
  const form = fonte.slice(fonte.indexOf('<form id="confirmar-presenca"'));
  const aviso = form.indexOf('<AvisoPresenca buffet={buffet} />'), campos = form.indexOf('<fieldset');
  assert.ok(aviso > 0 && aviso < campos, 'o aviso aparece antes dos campos');
  assert.equal(form.match(/<form /g)?.length, 1, 'um único formulário atende as duas variantes');
  assert.doesNotMatch(form.slice(0, aviso), /familia \?\s*<AvisoPresenca|!familia &&\s*<AvisoPresenca/, 'o aviso não depende da variante');
  assert.match(readFileSync('app/privacidade/page.tsx', 'utf8') + readFileSync('components/cadastro/DocumentoLegal.tsx', 'utf8'), /id=\{s\.id\}/, 'a âncora #tratamento-de-dados existe na página');
});
