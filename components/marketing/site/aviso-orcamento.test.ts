import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { carregarModulo } from '../../../lib/acessos/teste-carregador.ts';

// R-5 (P6): o Aviso de privacidade promete que os formulários públicos dos sites das empresas identificam o buffet,
// explicam a finalidade e levam ao aviso antes da coleta.
type Props = { acao: string; captura: Record<string, string>; buffet: string; previa?: boolean };
const { default: FormularioOrcamento } = carregarModulo('components/marketing/site/FormularioOrcamento.tsx', { 'components/marketing/site/site-publico.module.css': {} }) as { default: ComponentType<Props> };

test('formulário de orçamento do site: identifica o buffet, a finalidade e leva ao Aviso antes dos campos', () => {
  const html = renderToStaticMarkup(createElement(FormularioOrcamento, { acao: '/api/x', captura: {}, buffet: 'Buffet Exemplo' }));
  const aviso = html.indexOf('data-aviso-orcamento'), primeiroCampo = html.indexOf('name="nome"');
  assert.ok(aviso > 0 && aviso < primeiroCampo, 'o aviso vem antes do primeiro campo');
  assert.match(html, /O buffet Buffet Exemplo é o responsável pelos dados deste pedido/);
  assert.match(html, /só para responder ao seu pedido de orçamento/);
  assert.match(html, /href="\/privacidade#tratamento-de-dados"/);
});

test('formulário de orçamento do site: a página pública passa o nome do buffet', () => {
  const fonte = readFileSync('components/marketing/site/SitePublicoPagina.tsx', 'utf8');
  assert.match(fonte, /<FormularioOrcamento [^>]*buffet=\{c\.identidade\.nome\}/);
});
