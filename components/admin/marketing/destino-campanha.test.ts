import test from 'node:test';
import assert from 'node:assert/strict';
import { carregarModulo } from '../../../lib/acessos/teste-carregador.ts';
import { CANAIS_CAMPANHA_UI, linkDaCampanha } from '../../../lib/marketing/campanhas-ui.ts';

/**
 * r2 (P2 do Astra r1, decisão de Felipe em 24/11/2026: "quero que funcione com os dois ao mesmo tempo"): na empresa da
 * integração convivem campanhas para o site externo e para o site do iA.Fest. O link externo é só da campanha marcada
 * (destinoExterno); campanha antiga sem site segue com o link de antes.
 */
type Elemento = { type: unknown; props: Record<string, unknown> };
const jsx = (type: unknown, props: Record<string, unknown>): Elemento => ({ type, props });
const runtime = { jsx, jsxs: jsx, Fragment: 'fragment' };
const SITE_EXTERNO = 'https://kidmaisfestas.com';
const ORIGEM = 'https://app.example.test';

function campanha(id: string, codigo: string, extra: Record<string, unknown>) {
  return { id, codigo, nome: `Sintética ${codigo}`, canal: 'INSTAGRAM', origemCodigo: 'INSTAGRAM', objetivo: null, inicio: '2026-11-01', fim: null,
    orcamentoCentavos: null, utmSource: 'instagram', utmMedium: 'social', status: 'ATIVA', unidadeId: null, siteId: null, destinoExterno: false, versao: 1,
    criadaEm: 'x', atualizadaEm: 'x', ...extra };
}

function montar(dados: Record<string, unknown>) {
  const slots: unknown[] = []; let cursor = 0;
  const enviados: unknown[] = [];
  const react = {
    useState(inicial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = inicial; return [slots[i], (v: unknown) => { slots[i] = typeof v === 'function' ? (v as (x: unknown) => unknown)(slots[i]) : v; }]; },
    useRef(inicial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = { current: inicial }; return slots[i]; },
    useEffect() {},
  };
  const componente = carregarModulo('components/admin/marketing/MarketingCampanhas.tsx', {
    react, 'react/jsx-runtime': runtime, 'components/admin/marketing/marketing.module.css': {},
    'components/admin/marketing/comum': { useMarketing: () => ({ dados, recarregar() {}, setDados() {} }), CabecalhoMarketing: 'header', EstadoCarga: 'loading',
      enviarMarketing: async (_url: string, corpo: unknown) => { enviados.push(corpo); return {}; } },
    'components/admin/AdminPrimaryButton': { AdminPrimaryButton: 'button' },
    'components/admin/marketing/AtribuicaoExplicada': { AtribuicaoExplicada: 'aside' },
    'components/JanelaConfirmacao': { dialogo: {} },
  }).default as (props: Record<string, unknown>) => Elemento;
  const render = () => { cursor = 0; return componente({}); };
  return { render, enviados };
}
function todos(no: unknown, predicado: (e: Elemento) => boolean, saida: Elemento[] = []): Elemento[] {
  if (Array.isArray(no)) { for (const n of no) todos(n, predicado, saida); return saida; }
  if (!no || typeof no !== 'object' || !('props' in no)) return saida;
  const e = no as Elemento; if (predicado(e)) saida.push(e); todos(e.props.children, predicado, saida); return saida;
}
const texto = (no: unknown): string => Array.isArray(no) ? no.map(texto).join('') : no && typeof no === 'object' && 'props' in no ? texto((no as Elemento).props.children) : no == null || no === false ? '' : String(no);
const dadosBase = (extra: Record<string, unknown>) => ({ resultados: [], origens: [], unidades: [], origemPlataforma: ORIGEM,
  padraoPorCanal: Object.fromEntries(CANAIS_CAMPANHA_UI.map((c) => [c, { origem: c, utmSource: c.toLowerCase(), utmMedium: 'social' }])),
  capacidades: ['MARKETING_CAMPANHAS_EDITAR'], ...extra });
const seletorDestino = (t: Elemento) => todos(todos(t, (e) => e.type === 'label' && texto(e.props.children).startsWith('Site de destino'))[0], (e) => e.type === 'select')[0];
const abrirNova = (h: ReturnType<typeof montar>) => ((todos(h.render(), (e) => e.type === 'header')[0].props.acao as Elemento).props.onClick as () => void)();

test('136: na empresa da integração, campanha externa, interna com site e antiga sem site convivem, cada uma com o seu link', () => {
  const site = { id: 's1', slug: 'buffet-sintetico', unidadeId: null, estado: 'PUBLICADO' };
  const externa = campanha('c1', 'externa', { destinoExterno: true });
  const antiga = campanha('c2', 'antiga-sem-site', {});
  const interna = campanha('c3', 'interna', { siteId: 's1' });
  const h = montar(dadosBase({ siteKidmais: SITE_EXTERNO, sites: [site], campanhas: [externa, antiga, interna] }));
  const links = todos(h.render(), (e) => e.type === 'code').map((e) => texto(e.props.children));
  assert.equal(links.length, 3);
  assert.ok(links[0].startsWith(`${SITE_EXTERNO}/?`) && links[0].includes('campaign_id=c1'), 'externa: kidmaisfestas.com com campaign_id');
  assert.equal(links[1], linkDaCampanha(ORIGEM, 'buffet-sintetico', 'antiga-sem-site'), 'antiga sem site: o link de antes (não troca para o externo)');
  assert.equal(links[2], linkDaCampanha(ORIGEM, 'buffet-sintetico', 'interna'), 'interna: /s/<slug>');
});

test('136: seletor com Automático, o site externo e os sites; padrão externo só sem site PUBLICADO; salvar envia a escolha', async () => {
  const publicado = { id: 's1', slug: 'buffet-sintetico', unidadeId: null, estado: 'PUBLICADO' };
  const rascunho = { ...publicado, estado: 'RASCUNHO' };
  const comPublicado = montar(dadosBase({ siteKidmais: SITE_EXTERNO, sites: [publicado], campanhas: [] }));
  abrirNova(comPublicado);
  const sel = seletorDestino(comPublicado.render());
  assert.deepEqual(todos(sel, (e) => e.type === 'option').map((o) => [o.props.value, texto(o.props.children)]),
    [['', 'Automático'], ['__externo__', 'kidmaisfestas.com'], ['s1', '/s/buffet-sintetico']]);
  assert.equal(sel.props.value, 's1', 'com site PUBLICADO a nova campanha começa no site do iA.Fest');

  const semPublicado = montar(dadosBase({ siteKidmais: SITE_EXTERNO, sites: [rascunho], campanhas: [] }));
  abrirNova(semPublicado);
  assert.equal(seletorDestino(semPublicado.render()).props.value, '__externo__', 'sem site PUBLICADO: externo por padrão');
  const semSite = montar(dadosBase({ siteKidmais: SITE_EXTERNO, sites: [], campanhas: [] }));
  abrirNova(semSite);
  assert.equal(seletorDestino(semSite.render()).props.value, '__externo__');

  // Troca para o externo e salva: destinoExterno true e siteId null.
  (seletorDestino(comPublicado.render()).props.onChange as (e: { target: { value: string } }) => void)({ target: { value: '__externo__' } });
  const form = () => todos(comPublicado.render(), (e) => e.type === 'form')[0];
  (todos(form(), (e) => e.type === 'input')[0].props.onChange as (e: { target: { value: string } }) => void)({ target: { value: 'Sintética nova' } });
  await (form().props.onSubmit as (e: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} });
  assert.equal(comPublicado.enviados.length, 1);
  assert.deepEqual([(comPublicado.enviados[0] as { destinoExterno: unknown }).destinoExterno, (comPublicado.enviados[0] as { siteId: unknown }).siteId], [true, null]);
});

test('136: fora da empresa da integração (ou sem a 136) não há opção externa, nada muda de link e o campo não é enviado', async () => {
  const site = { id: 's1', slug: 'buffet-sintetico', unidadeId: null, estado: 'PUBLICADO' };
  const h = montar(dadosBase({ siteKidmais: null, sites: [site], campanhas: [campanha('c2', 'antiga-sem-site', {}), campanha('c4', 'marcada', { destinoExterno: true })] }));
  const links = todos(h.render(), (e) => e.type === 'code').map((e) => texto(e.props.children));
  assert.deepEqual(links, [linkDaCampanha(ORIGEM, 'buffet-sintetico', 'antiga-sem-site'), linkDaCampanha(ORIGEM, 'buffet-sintetico', 'marcada')]);
  abrirNova(h);
  const sel = seletorDestino(h.render());
  assert.deepEqual(todos(sel, (e) => e.type === 'option').map((o) => o.props.value), ['', 's1']);
  const form = () => todos(h.render(), (e) => e.type === 'form')[0];
  (todos(form(), (e) => e.type === 'input')[0].props.onChange as (e: { target: { value: string } }) => void)({ target: { value: 'Sintética' } });
  await (form().props.onSubmit as (e: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} });
  assert.equal('destinoExterno' in (h.enviados[0] as object), false);
});
