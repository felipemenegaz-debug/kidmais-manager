import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { carregarModulo } from '../../acessos/teste-carregador.ts';
import { cssFalso } from '../../../components/admin/teste-componente.ts';
import { conteudoVazio, esquemaConteudoSite, imagensReferenciadas, pendenciasParaPublicar, sugerirSlug, type ConteudoPublicado } from './conteudo.ts';
import { dadosEstruturados, jsonLdSeguro, metadataSite, robotsTxt, sitemapXml, urlCanonica } from './seo.ts';

const IMG = '11111111-1111-4111-8111-111111111111';

function publicado(extra: Partial<ConteudoPublicado> = {}): ConteudoPublicado {
  const base = esquemaConteudoSite.parse({
    identidade: { nome: 'Buffet Alegria', slogan: 'Festas <b>inesquecíveis</b>', corPrimaria: '#AA00FF' },
    apresentacao: { titulo: 'Bem-vindo', texto: '<script>alert(1)</script>\n\nSegundo parágrafo' },
    galeria: [{ imagemId: IMG, legenda: 'Salão' }],
    estrutura: { itens: ['Brinquedoteca'] }, localizacao: { mostrar: true, endereco: 'Rua A, 10', cidade: 'São Paulo', uf: 'sp' },
    contato: { whatsapp: '(11) 99999-0000', instagram: 'https://instagram.com/buffetalegria' }, formulario: {},
    seo: { titulo: 'Buffet Alegria em SP', descricao: 'Festas infantis' },
  });
  return { ...base, pacotes: [{ codigo: 'COMPLETA', nome: 'Completa', descricao: null, destaque: '', convidadosMinimos: 50, convidadosMaximos: 100, duracaoMinutos: 240, precoAPartirCentavos: 450000 }],
    versao: 1, publicadoEm: '2026-10-14T12:00:00Z', rascunhoHash: 'x', ...extra };
}

test('conteúdo: cor só #rrggbb, link só http(s) sem credencial, texto sem caracteres de controle', () => {
  const c = publicado();
  assert.equal(c.identidade.corPrimaria, '#aa00ff');
  assert.equal(c.localizacao.uf, 'SP');
  assert.equal(esquemaConteudoSite.safeParse({ ...c, identidade: { ...c.identidade, corPrimaria: 'red;}body{display:none' } }).success, false);
  assert.equal(esquemaConteudoSite.safeParse({ ...c, contato: { ...c.contato, instagram: 'javascript:alert(1)' } }).success, false);
  assert.equal(esquemaConteudoSite.safeParse({ ...c, localizacao: { ...c.localizacao, linkMapa: 'https://u:p@maps.example.com' } }).success, false);
  assert.equal(esquemaConteudoSite.safeParse({ ...c, extra: 1 }).success, false, 'campo desconhecido recusado');
  const limpo = esquemaConteudoSite.parse({ ...conteudoVazio('XY'), identidade: { ...conteudoVazio('XY').identidade, nome: 'Bu\u0000ffet' } });
  assert.equal(limpo.identidade.nome, 'Buffet');
  assert.deepEqual(imagensReferenciadas({ identidade: { ...c.identidade, logoImagemId: IMG }, galeria: c.galeria }), [IMG]);
  assert.deepEqual(pendenciasParaPublicar(conteudoVazio('Buffet')).length > 0, true);
  assert.equal(sugerirSlug('Buffet Alegria & Cia'), 'buffet-alegria-cia');
  assert.equal(sugerirSlug('123'), 'buffet-123');
});

test('página pública: texto do usuário é renderizado como texto (HTML/script escapados), sem rascunho', () => {
  const mod = carregarModulo('components/marketing/site/SitePublicoPagina.tsx', {
    'site-publico.module.css': cssFalso,
    'site/FormularioOrcamento': { __esModule: true, default: () => createElement('form', { 'data-formulario': 'sim' }) },
  }) as { default: (p: unknown) => unknown };
  const html = renderToStaticMarkup(createElement(mod.default as never, {
    conteudo: publicado(), urlImagem: (id: string) => `/s/alegria/imagens/${id}`, base: '/s/alegria', acaoFormulario: '/api/publico/marketing/alegria/contato',
    captura: { kc: 'nov-centro' }, datasLivres: [{ data: '2026-10-17', diaSemana: 6 }],
  }));
  assert.ok(!html.includes('<script>alert(1)</script>'), 'script do usuário não vira tag');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('Festas &lt;b&gt;inesquecíveis&lt;/b&gt;'));
  assert.ok(html.includes('/s/alegria/whatsapp?kc=nov-centro'), 'clique no WhatsApp passa pelo registro separado');
  assert.ok(html.includes('a partir de'));
  assert.ok(html.includes('sujeita a confirmação'));
  assert.ok(html.includes('--cor-primaria:#aa00ff'));
});

test('SEO: canonical único (domínio real > plataforma; simulado nunca); JSON-LD escapado; sitemap só indexável', () => {
  const env = { SITE_URL: 'https://kidmais.exemplo.com.br' };
  assert.equal(urlCanonica('alegria', null, env), 'https://kidmais.exemplo.com.br/s/alegria');
  assert.equal(urlCanonica('alegria', { host: 'festas.alegria.com.br', simulado: true }, env), 'https://kidmais.exemplo.com.br/s/alegria');
  assert.equal(urlCanonica('alegria', { host: 'festas.alegria.com.br', simulado: false }, env), 'https://festas.alegria.com.br/');
  const c = publicado({ identidade: { ...publicado().identidade, nome: 'A </script><script>x</script>' } });
  const ld = jsonLdSeguro(dadosEstruturados(c, 'https://x/s/a', []));
  assert.ok(!ld.includes('</script>'));
  assert.ok(ld.includes('\\u003c/script\\u003e'));
  const dados = dadosEstruturados(publicado(), 'https://x/s/a', ['https://x/s/a/imagens/1']) as Record<string, unknown>;
  assert.equal(dados['@type'], 'LocalBusiness');
  assert.equal(dados.telephone, '+5511999990000');
  assert.equal((dados.address as Record<string, unknown>).addressLocality, 'São Paulo');
  assert.equal(sitemapXml([]).includes('<url>'), false);
  assert.ok(sitemapXml([{ url: 'https://x/s/a?a=1&b=2', atualizadoEm: '2026-10-14T00:00:00Z' }]).includes('https://x/s/a?a=1&amp;b=2'));
  assert.equal(robotsTxt({ indexavel: false, sitemap: null }), 'User-agent: *\nDisallow: /\n');
  assert.ok(robotsTxt({ indexavel: true, sitemap: 'https://x/sitemap.xml' }).includes('Sitemap: https://x/sitemap.xml'));
  const meta = metadataSite(publicado(), { canonical: 'https://x/s/a', indexavel: false, imagemAbsoluta: null });
  assert.deepEqual(meta.robots, { index: false, follow: false, nocache: true });
  assert.equal((meta.alternates as { canonical: string }).canonical, 'https://x/s/a');
});
