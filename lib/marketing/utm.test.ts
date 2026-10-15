import assert from 'node:assert/strict';
import test from 'node:test';
import { campanhaVigente, capturarCampanha, destinoComUtm, hojeSaoPaulo, linkRastreavel, sugerirCodigoCampanha } from './utm.ts';
import { linkDaCampanha } from './campanhas-ui.ts';
import { mesclarOrigens, rotuloOrigem, codigoPersonalizado, ORIGENS_PADRAO } from './origens.ts';

test('UTM: valores válidos são normalizados; inválidos, repetidos e ausentes não viram atribuição', () => {
  const ok = capturarCampanha(new URLSearchParams('utm_source=Instagram&utm_medium=social&utm_campaign=novembro-centro&kc=novembro-centro'));
  assert.deepEqual(ok.utm, { utm_source: 'instagram', utm_medium: 'social', utm_campaign: 'novembro-centro' });
  assert.equal(ok.codigoCampanha, 'novembro-centro');
  assert.deepEqual(ok.descartados, []);

  const ruim = capturarCampanha(new URLSearchParams('utm_source=<script>&utm_medium=a%20b&kc=x&utm_term=' + 'a'.repeat(61)));
  assert.deepEqual(ruim.utm, {});
  assert.equal(ruim.codigoCampanha, null);
  assert.deepEqual(ruim.descartados.sort(), ['kc', 'utm_medium', 'utm_source', 'utm_term']);

  const repetido = capturarCampanha(new URLSearchParams('kc=campanha-a&kc=campanha-b&utm_source=google&utm_source=bing'));
  assert.equal(repetido.codigoCampanha, null, 'kc repetido é ambíguo: nenhuma campanha');
  assert.equal(repetido.utm.utm_source, undefined);

  const vazio = capturarCampanha({});
  assert.deepEqual(vazio, { codigoCampanha: null, utm: {}, descartados: [] });

  const objeto = capturarCampanha({ kc: 'campanha-ok', utm_source: ['google'] });
  assert.equal(objeto.codigoCampanha, 'campanha-ok');
  assert.equal(objeto.utm.utm_source, 'google');
});

test('links: o rastreável passa pelo clique; o destino leva UTM e kc da campanha', () => {
  assert.equal(linkRastreavel('http://localhost:3000/s/alegria/', { codigo: 'nov-centro' }), 'http://localhost:3000/s/alegria/c/nov-centro');
  assert.equal(linkDaCampanha('http://localhost:3000/', 'alegria', 'nov-centro'), 'http://localhost:3000/s/alegria/c/nov-centro');
  const destino = destinoComUtm('http://localhost:3000/s/alegria', { codigo: 'nov-centro', utmSource: 'instagram', utmMedium: 'social' });
  assert.equal(destino.pathname, '/s/alegria/');
  assert.equal(destino.searchParams.get('kc'), 'nov-centro');
  assert.equal(destino.searchParams.get('utm_campaign'), 'nov-centro');
  assert.equal(destino.searchParams.get('utm_source'), 'instagram');
});

test('código da campanha sugerido é estável, minúsculo e válido; período vigente respeita status e datas', () => {
  assert.match(sugerirCodigoCampanha('Promoção de Novembro — Centro!', '2611'), /^[a-z0-9][a-z0-9-]{2,46}[a-z0-9]$/);
  assert.equal(sugerirCodigoCampanha('Promoção', '01'), 'promocao-01');
  assert.equal(campanhaVigente({ status: 'ATIVA', inicio: '2026-10-01', fim: '2026-10-31' }, '2026-10-14'), true);
  assert.equal(campanhaVigente({ status: 'PAUSADA', inicio: '2026-10-01', fim: null }, '2026-10-14'), false);
  assert.equal(campanhaVigente({ status: 'ATIVA', inicio: '2026-10-15', fim: null }, '2026-10-14'), false);
  assert.equal(hojeSaoPaulo(new Date('2026-10-15T02:30:00Z')), '2026-10-14', 'fuso de São Paulo');
});

test('origens: padrão + ajustes da empresa + personalizadas; desconhecida nunca é opção', () => {
  const lista = mesclarOrigens([
    { codigo: 'FACEBOOK', rotulo: 'Facebook/Meta', ativa: false, ordem: 5, personalizada: false },
    { codigo: 'P_FEIRA_DE_NOIVAS', rotulo: 'Feira de noivas', ativa: true, ordem: 200, personalizada: true },
  ]);
  assert.equal(lista.length, ORIGENS_PADRAO.length + 1);
  assert.equal(lista[0].codigo, 'FACEBOOK');
  assert.equal(lista[0].ativa, false);
  assert.equal(lista.at(-1)?.codigo, 'P_FEIRA_DE_NOIVAS');
  assert.equal(lista.some((o) => o.codigo === 'DESCONHECIDA'), false);
  assert.equal(rotuloOrigem('DESCONHECIDA', lista), 'Desconhecida (sem evidência)');
  assert.equal(rotuloOrigem('NAO_INFORMADO', lista), 'Não informado');
  assert.equal(codigoPersonalizado('Feira de Noivas 2026!'), 'P_FEIRA_DE_NOIVAS_2026');
  assert.throws(() => codigoPersonalizado('!'), { code: 'MARKETING_ORIGEM_INVALIDA' });
});
