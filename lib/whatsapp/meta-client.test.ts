import assert from 'node:assert/strict';
import test from 'node:test';
import { trocarCodigoEValidarAtivos } from './meta-client.ts';
import { exigirConfiguracaoWhatsappPrivada } from './configuracao.ts';

const config = exigirConfiguracaoWhatsappPrivada({
  KIDMAIS_DEPLOY_ENV: 'staging', META_APP_ID: '1', META_APP_SECRET: 'segredo-sintetico-valido',
  META_GRAPH_API_VERSION: 'v24.0', META_EMBEDDED_SIGNUP_CONFIG_ID: '2',
  META_OAUTH_REDIRECT_URI: 'https://staging.example.invalid/callback',
  META_EMBEDDED_SIGNUP_OPTIONS_JSON: '{"response_type":"code","override_default_response_type":true}',
  META_EMBEDDED_SIGNUP_EVENT_NAME: 'FINISH', META_EMBEDDED_SIGNUP_MESSAGE_ORIGINS: 'https://www.facebook.com',
});

/**
 * Modelo sintético (nenhuma chamada real): o token AUTORIZA a WABA 20 e os negócios 10 e 11. PERTENCIMENTO, que só a
 * aresta owned_whatsapp_business_accounts expressa: WABA 20 é do negócio 10; o negócio 11 possui a WABA 21.
 * Autorizado ≠ pertencente: as listas do debug_token não dizem qual WABA é de qual negócio.
 */
const entrada = { code: 'codigo-sintetico', businessId: '10', wabaId: '20', phoneNumberId: '30' };
const escopos = ['whatsapp_business_management', 'whatsapp_business_messaging', 'business_management'];
const granularOk = [
  { scope: 'whatsapp_business_management', target_ids: ['20', '99'] },
  { scope: 'whatsapp_business_messaging', target_ids: ['20'] },
  { scope: 'business_management', target_ids: ['10', '11'] },
];
const posse: Record<string, unknown> = { 10: { data: [{ id: '20' }] }, 11: { data: [{ id: '21' }] } };
const numeroOk = { id: '30', display_phone_number: '+55 11 0000-0000', verified_name: 'Demo', is_on_biz_app: true };

type Etapa = 'oauth' | 'debug' | 'posse' | 'numeros';
type Respostas = { debug?: unknown; posse?: unknown; numeros?: unknown; status?: Partial<Record<Etapa, number>> };
function metaSimulada(r: Respostas = {}) {
  const etapas: Etapa[] = [];
  const urls: string[] = [];
  const tokens: (string | null)[] = [];
  const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); urls.push(url);
    tokens.push(new Headers(init?.headers).get('authorization'));
    const posseDe = /\/v24\.0\/([0-9]+)\/owned_whatsapp_business_accounts\?/.exec(url)?.[1];
    const [etapa, body]: [Etapa, unknown] = url.includes('/oauth/access_token') ? ['oauth', { access_token: 'token-sintetico', token_type: 'bearer', expires_in: 3600 }]
      : url.includes('/debug_token') ? ['debug', r.debug ?? { data: { is_valid: true, app_id: '1', scopes: escopos, granular_scopes: granularOk } }]
        : posseDe ? ['posse', r.posse ?? posse[posseDe] ?? { data: [] }]
          : ['numeros', r.numeros ?? { data: [numeroOk] }];
    etapas.push(etapa);
    return new Response(JSON.stringify(body), { status: r.status?.[etapa] ?? 200 });
  };
  return { etapas, urls, tokens, fetch: fetchMock as typeof fetch };
}
const debugCom = (granular: unknown) => ({ data: { is_valid: true, app_id: '1', scopes: escopos, granular_scopes: granular } });

test('combinação comprovada: WABA autorizada e POSSUÍDA pelo negócio informado, número da WABA, coexistência', async () => {
  const meta = metaSimulada();
  const result = await trocarCodigoEValidarAtivos(entrada, config, meta.fetch);
  assert.equal(result.accessToken, 'token-sintetico'); assert.equal(result.verifiedName, 'Demo');
  assert.equal(result.displayPhoneNumber, '+55 11 0000-0000');
  assert.deepEqual(meta.etapas, ['oauth', 'debug', 'posse', 'numeros']);
  assert.match(meta.urls[2], /\/v24\.0\/10\/owned_whatsapp_business_accounts\?fields=id&limit=100$/);
  assert.match(meta.urls[3], /\/v24\.0\/20\/phone_numbers\?/);
  assert.ok(meta.urls.every((url) => !url.includes('client_whatsapp_business_accounts')), 'não consulta a aresta do parceiro com o negócio do cliente');
  assert.deepEqual(meta.tokens.slice(2), ['Bearer token-sintetico', 'Bearer token-sintetico'], 'posse e números lidos com o token do cliente');
});

test('combinação cruzada: token autorizado nos negócios 10 e 11, WABA 20 só do 10 → (11, 20) recusada', async () => {
  const meta = metaSimulada();
  await assert.rejects(trocarCodigoEValidarAtivos({ ...entrada, businessId: '11' }, config, meta.fetch), { code: 'META_WABA_DIVERGENTE', httpStatus: 409 });
  assert.deepEqual(meta.etapas, ['oauth', 'debug', 'posse'], 'para antes de consultar números');
  assert.match(meta.urls[2], /\/11\/owned_whatsapp_business_accounts\?/);
});

test('autorização: WABA ou negócio fora dos ativos autorizados por este token é recusado antes da posse', async () => {
  const wabaNao = metaSimulada({ debug: debugCom([{ scope: 'whatsapp_business_management', target_ids: ['77'] }, { scope: 'business_management', target_ids: ['10'] }]) });
  await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, wabaNao.fetch), { code: 'META_WABA_DIVERGENTE', httpStatus: 409 });
  assert.deepEqual(wabaNao.etapas, ['oauth', 'debug']);
  const negocioNao = metaSimulada({ debug: debugCom([{ scope: 'whatsapp_business_management', target_ids: ['20'] }, { scope: 'business_management', target_ids: ['11'] }]) });
  await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, negocioNao.fetch), { code: 'META_NEGOCIO_DIVERGENTE', httpStatus: 409 });
  assert.deepEqual(negocioNao.etapas, ['oauth', 'debug']);
});

test('escopo sem alvos explícitos não prova a autorização do ativo (fail-closed)', async () => {
  const semAlvoWaba = metaSimulada({ debug: debugCom([{ scope: 'whatsapp_business_management' }, { scope: 'business_management', target_ids: ['10'] }]) });
  await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, semAlvoWaba.fetch), { code: 'META_WABA_DIVERGENTE' });
  const semNegocio = metaSimulada({ debug: debugCom([{ scope: 'whatsapp_business_management', target_ids: ['20'] }]) });
  await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, semNegocio.fetch), { code: 'META_NEGOCIO_DIVERGENTE' });
});

test('relação ausente, ambígua ou não confirmada: recusa segura, sem consultar números', async () => {
  const casos: [string, Respostas][] = [
    ['Meta recusa a leitura da posse (403)', { posse: { error: { message: 'permissão', code: 200 } }, status: { posse: 403 } }],
    ['corpo de erro com 200', { posse: { error: { message: 'falha' } } }],
    ['resposta sem lista', { posse: { paging: {} } }],
    ['item sem id', { posse: { data: [{ name: 'sem id' }, { id: '20' }] } }],
    ['lista paginada sem a WABA', { posse: { data: [{ id: '21' }], paging: { next: 'https://graph.facebook.com/next' } } }],
    ['corpo inválido', { posse: 'não é json de lista' }],
  ];
  for (const [rotulo, respostas] of casos) {
    const meta = metaSimulada(respostas);
    await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, meta.fetch), { code: 'META_RELACAO_NAO_CONFIRMADA', httpStatus: 409 }, rotulo);
    assert.deepEqual(meta.etapas, ['oauth', 'debug', 'posse'], rotulo);
  }
  const vazia = metaSimulada({ posse: { data: [] } });
  await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, vazia.fetch), { code: 'META_WABA_DIVERGENTE' }, 'lista completa sem a WABA');
});

test('número de outra WABA é recusado', async () => {
  const meta = metaSimulada({ numeros: { data: [{ ...numeroOk, id: '31' }] } });
  await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, meta.fetch), { code: 'META_NUMERO_DIVERGENTE', httpStatus: 409 });
});

test('resposta incompleta: sem granular_scopes, sem identificação do número ou sem escopo obrigatório', async () => {
  const semGranular = metaSimulada({ debug: { data: { is_valid: true, app_id: '1', scopes: escopos } } });
  await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, semGranular.fetch), { code: 'META_AUTORIZACAO_INCOMPLETA' });
  const semNome = metaSimulada({ numeros: { data: [{ id: '30', display_phone_number: '+55', is_on_biz_app: true }] } });
  await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, semNome.fetch), { code: 'META_NUMERO_INCOMPLETO' });
  const semEscopo = metaSimulada({ debug: { data: { is_valid: true, app_id: '1', scopes: ['whatsapp_business_management'], granular_scopes: granularOk } } });
  await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, semEscopo.fetch), { code: 'META_ESCOPO_INVALIDO' });
  const outroApp = metaSimulada({ debug: { data: { is_valid: true, app_id: '9', scopes: escopos, granular_scopes: granularOk } } });
  await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, outroApp.fetch), { code: 'META_ESCOPO_INVALIDO' });
});

test('coexistência não confirmada é recusada', async () => {
  const meta = metaSimulada({ numeros: { data: [{ ...numeroOk, is_on_biz_app: false }] } });
  await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, meta.fetch), /coexistência/);
});

test('falha do provedor: erro HTTP em cada etapa, corpo de erro e falha de rede nunca devolvem validação', async () => {
  for (const etapa of ['oauth', 'debug', 'posse', 'numeros'] as const) {
    const meta = metaSimulada({ status: { [etapa]: 500 } });
    await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, meta.fetch), { code: 'META_API_RECUSOU', httpStatus: 502 }, etapa);
  }
  const corpoErro = metaSimulada({ debug: { error: { message: 'falha simulada' } } });
  await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, corpoErro.fetch), { code: 'META_API_RECUSOU' });
  const rede = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, rede), TypeError);
});
