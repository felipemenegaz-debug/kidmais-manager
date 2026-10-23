import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { elementos, carregarComponente, cssFalso, texto } from './teste-componente.ts';

/** Pedido de Felipe (23/10/2026): tabela de preços e modelo de contrato na mesma página, "Importar documentos". */
const Link = function Link() {};
const Tabela = function ImportacaoTabelaPrecos() {};
const Contrato = function ModeloContrato() {};
const tela = () => carregarComponente('components/admin/ImportarDocumentos.tsx', {
  'next/link': { default: Link }, './ImportacaoTabelaPrecos': { default: Tabela }, './ModeloContrato': { default: Contrato },
  './importar-documentos.module.css': cssFalso,
});

test('abas: a da URL fica marcada e mostra a tela daquele documento; o resto cai na tabela', () => {
  const m = tela();
  const documentoDaUrl = (m.modulo as { documentoDaUrl(v: unknown): string }).documentoDaUrl;
  assert.equal(documentoDaUrl('contrato'), 'contrato');
  for (const v of ['tabela', undefined, '', 'outra', ['contrato']]) assert.equal(documentoDaUrl(v), 'tabela', JSON.stringify(v));
  for (const [documento, componente, outro] of [['tabela', Tabela, Contrato], ['contrato', Contrato, Tabela]] as const) {
    const arvore = m.render('default', { documento });
    assert.match(texto(arvore), /Importar documentos/);
    const abas = elementos(arvore).filter((e) => e.type === Link);
    assert.deepEqual(abas.map((a) => a.props.href), ['/admin/configuracoes/importar-documentos?documento=tabela', '/admin/configuracoes/importar-documentos?documento=contrato']);
    assert.deepEqual(abas.map((a) => a.props['aria-current']), documento === 'tabela' ? ['page', undefined] : [undefined, 'page']);
    assert.equal(elementos(arvore).some((e) => e.type === componente), true, documento);
    assert.equal(elementos(arvore).some((e) => e.type === outro), false, documento);
  }
});

test('Configurações: um cartão "Importar documentos"; as rotas antigas redirecionam para a aba certa', () => {
  const hub = readFileSync('app/admin/configuracoes/page.tsx', 'utf8');
  assert.match(hub, /route:'importar-documentos', title:'Importar documentos'/);
  assert.doesNotMatch(hub, /route:'importar-tabela'|route:'modelo-contrato'/);
  assert.match(readFileSync('app/admin/configuracoes/importar-tabela/page.tsx', 'utf8'), /redirect\('\/admin\/configuracoes\/importar-documentos\?documento=tabela'\)/);
  assert.match(readFileSync('app/admin/configuracoes/modelo-contrato/page.tsx', 'utf8'), /redirect\('\/admin\/configuracoes\/importar-documentos\?documento=contrato'\)/);
  assert.doesNotMatch(readFileSync('components/admin/PacotesAdmin.tsx', 'utf8'), /configuracoes\/importar-tabela/);
});
