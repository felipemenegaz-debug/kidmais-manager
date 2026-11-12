import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { elementos, carregarComponente, cssFalso, texto } from './teste-componente.ts';

/** Pedido de Felipe (23/10/2026): tabela de preços, modelo de contrato e contrato de festa na mesma página, "Importar documentos". */
const Link = function Link() {};
const Tabela = function ImportacaoTabelaPrecos() {};
const Contrato = function ModeloContrato() {};
const Festa = function ImportacaoContrato() {};
// As abas são AbaDocumento (Link com a pergunta de saída do modelo de contrato, plano v3).
const tela = () => carregarComponente('components/admin/ImportarDocumentos.tsx', {
  './modelo-contrato/AbaDocumento': { default: Link }, './ImportacaoTabelaPrecos': { default: Tabela }, './ModeloContrato': { default: Contrato },
  './importacao/ImportacaoContrato': { default: Festa }, './importar-documentos.module.css': cssFalso,
});
const HREFS = ['tabela', 'contrato', 'festa'].map((d) => `/admin/configuracoes/importar-documentos?documento=${d}`);

test('abas: a da URL fica marcada e mostra a tela daquele documento; o resto cai na tabela', () => {
  const m = tela();
  const documentoDaUrl = (m.modulo as { documentoDaUrl(v: unknown): string }).documentoDaUrl;
  assert.equal(documentoDaUrl('contrato'), 'contrato');
  assert.equal(documentoDaUrl('festa'), 'festa');
  for (const v of ['tabela', undefined, '', 'outra', ['contrato'], ['festa']]) assert.equal(documentoDaUrl(v), 'tabela', JSON.stringify(v));
  const telas = { tabela: Tabela, contrato: Contrato, festa: Festa } as const;
  for (const documento of ['tabela', 'contrato', 'festa'] as const) {
    const arvore = m.render('default', { documento });
    assert.match(texto(arvore), /Importar documentos/);
    const abas = elementos(arvore).filter((e) => e.type === Link);
    assert.deepEqual(abas.map((a) => a.props.href), HREFS);
    assert.deepEqual(abas.map((a) => a.props['aria-current']), HREFS.map((h) => h.endsWith(`=${documento}`) ? 'page' : undefined));
    for (const [nome, componente] of Object.entries(telas)) assert.equal(elementos(arvore).some((e) => e.type === componente), nome === documento, `${documento}: ${nome}`);
  }
  // "Contrato de festa" é o MESMO fluxo de Contratos › Importar contrato antigo.
  assert.match(texto(m.render('default', { documento: 'festa' })), /Contrato de festa/);
  assert.equal(readFileSync('app/admin/contratos/importar/page.tsx', 'utf8').includes("import ImportacaoContrato from '@/components/admin/importacao/ImportacaoContrato'"), true);
});

test('Configurações: um cartão "Importar documentos"; as rotas antigas redirecionam para a aba certa', () => {
  const hub = readFileSync('app/admin/configuracoes/page.tsx', 'utf8');
  assert.match(hub, /route:'importar-documentos', title:'Importar documentos'/);
  assert.match(hub, /contrato antigo de uma festa/);
  assert.doesNotMatch(hub, /route:'importar-tabela'|route:'modelo-contrato'/);
  assert.match(readFileSync('app/admin/configuracoes/importar-tabela/page.tsx', 'utf8'), /redirect\('\/admin\/configuracoes\/importar-documentos\?documento=tabela'\)/);
  assert.match(readFileSync('app/admin/configuracoes/modelo-contrato/page.tsx', 'utf8'), /redirect\('\/admin\/configuracoes\/importar-documentos\?documento=contrato'\)/);
  assert.doesNotMatch(readFileSync('components/admin/PacotesAdmin.tsx', 'utf8'), /configuracoes\/importar-tabela/);
});

test('Festas: o botão "Importar contrato de festa" fica no topo, como em Contratos, e leva ao mesmo fluxo', () => {
  const festas = readFileSync('components/festas/FestaConsole.tsx', 'utf8');
  assert.match(festas, /<div className=\{styles\.tituloFestas\}><h1>Festas<\/h1><Link className=\{styles\.importarContrato\} href="\/admin\/contratos\/importar">Importar contrato de festa<\/Link><\/div>/);
  assert.match(readFileSync('components/admin/ContratoAdmin.tsx', 'utf8'), /href="\/admin\/contratos\/importar">Importar contrato antigo<\/Link>/);
  const css = readFileSync('components/festas/festa.module.css', 'utf8');
  assert.match(css, /\.importarContrato \{ composes: primario from "\.\.\/admin\/visual\.module\.css"; \}/);
  assert.match(css, /\.page a\.importarContrato \{ color:white; text-decoration:none; \}/, 'o link de Festas não herda o sublinhado de .page a');
});
