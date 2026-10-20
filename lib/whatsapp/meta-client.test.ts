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

type Etapa = 'oauth' | 'debug' | 'posse' | 'numeros' | 'inscricao';
type Respostas = { debug?: unknown; posse?: unknown; posseDe?: Record<string, { body: unknown; status?: number }>; numeros?: unknown; inscricao?: unknown; inscricaoRede?: boolean; inscricaoPrazo?: boolean; status?: Partial<Record<Etapa, number>> };
function metaSimulada(r: Respostas = {}) {
  const etapas: Etapa[] = [];
  const urls: string[] = [];
  const tokens: (string | null)[] = [];
  const metodos: string[] = [];
  const sinais: (AbortSignal | null | undefined)[] = [];
  const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); urls.push(url); metodos.push(init?.method ?? 'GET');
    tokens.push(new Headers(init?.headers).get('authorization'));
    if (/\/v24\.0\/[0-9]+\/subscribed_apps$/.test(url)) {
      etapas.push('inscricao');
      sinais.push(init?.signal);
      if (r.inscricaoRede) throw new TypeError('fetch failed');
      if (r.inscricaoPrazo) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      const corpo = 'inscricao' in r ? r.inscricao : { success: true };
      return new Response(typeof corpo === 'string' ? corpo : JSON.stringify(corpo), { status: r.status?.inscricao || 200 });
    }
    const posseDe = /\/v24\.0\/([0-9]+)\/owned_whatsapp_business_accounts\?/.exec(url)?.[1];
    const [etapa, body]: [Etapa, unknown] = url.includes('/oauth/access_token') ? ['oauth', { access_token: 'token-sintetico', token_type: 'bearer', expires_in: 3600 }]
      : url.includes('/debug_token') ? ['debug', r.debug ?? { data: { is_valid: true, app_id: '1', scopes: escopos, granular_scopes: granularOk } }]
        : posseDe ? ['posse', r.posseDe?.[posseDe]?.body ?? r.posse ?? posse[posseDe] ?? { data: [] }]
          : ['numeros', r.numeros ?? { data: [numeroOk] }];
    etapas.push(etapa);
    return new Response(JSON.stringify(body), { status: (posseDe && r.posseDe?.[posseDe]?.status) || r.status?.[etapa] || 200 });
  };
  return { etapas, urls, tokens, metodos, sinais, fetch: fetchMock as typeof fetch };
}
const debugCom = (granular: unknown) => ({ data: { is_valid: true, app_id: '1', scopes: escopos, granular_scopes: granular } });

test('combinação comprovada: WABA autorizada e POSSUÍDA pelo negócio informado, número da WABA, coexistência', async () => {
  const meta = metaSimulada();
  const result = await trocarCodigoEValidarAtivos(entrada, config, meta.fetch);
  assert.equal(result.accessToken, 'token-sintetico'); assert.equal(result.verifiedName, 'Demo');
  assert.equal(result.displayPhoneNumber, '+55 11 0000-0000');
  assert.deepEqual(meta.etapas, ['oauth', 'debug', 'posse', 'numeros', 'inscricao']);
  assert.equal(meta.urls[4], 'https://graph.facebook.com/v24.0/20/subscribed_apps');
  assert.deepEqual(meta.metodos, ['GET', 'GET', 'GET', 'GET', 'POST'], 'só a inscrição escreve na Meta, por último');
  assert.equal(result.webhookInscrito, true);
  assert.match(meta.urls[2], /\/v24\.0\/10\/owned_whatsapp_business_accounts\?fields=id&limit=100$/);
  assert.match(meta.urls[3], /\/v24\.0\/20\/phone_numbers\?/);
  assert.ok(meta.urls.every((url) => !url.includes('client_whatsapp_business_accounts')), 'não consulta a aresta do parceiro com o negócio do cliente');
  assert.deepEqual(meta.tokens.slice(2), ['Bearer token-sintetico', 'Bearer token-sintetico', 'Bearer token-sintetico'], 'posse, números e inscrição com o token do cliente');
  assert.deepEqual([result.businessId, result.phoneNumberId], ['10', '30'], 'ids informados e comprovados são devolvidos');
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

/**
 * D2: o exemplo oficial do evento do WhatsApp Business App traz em `data` só `waba_id`. Negócio e número são então
 * resolvidos no servidor e COMPROVADOS: dono = o negócio autorizado cuja aresta de posse contém a WABA; número = o único
 * da WABA em coexistência. Nunca o primeiro da lista ou a ordem.
 */
const soWaba = { code: 'codigo-sintetico', wabaId: '20' };

test('D2: só waba_id → negócio dono comprovado entre os autorizados e o único número em coexistência', async () => {
  const meta = metaSimulada({ numeros: { data: [{ ...numeroOk, id: '29', is_on_biz_app: false }, numeroOk] } });
  const result = await trocarCodigoEValidarAtivos(soWaba, config, meta.fetch);
  assert.deepEqual([result.businessId, result.phoneNumberId, result.verifiedName], ['10', '30', 'Demo']);
  assert.deepEqual(meta.etapas, ['oauth', 'debug', 'posse', 'posse', 'numeros', 'inscricao'], 'confere a posse de cada negócio autorizado');
  assert.ok(meta.urls.some((u) => u.includes('/10/owned_')) && meta.urls.some((u) => u.includes('/11/owned_')));
});

test('D2: a ordem dos autorizados não decide o dono', async () => {
  const meta = metaSimulada({ debug: debugCom([{ scope: 'whatsapp_business_management', target_ids: ['20'] }, { scope: 'business_management', target_ids: ['11', '10'] }]) });
  assert.equal((await trocarCodigoEValidarAtivos(soWaba, config, meta.fetch)).businessId, '10');
});

test('D2: negócio sem prova → recusa (nenhum dono, dois donos, posse não confirmada, sem alvos, alvos demais)', async () => {
  const nenhum = metaSimulada({ posseDe: { 10: { body: { data: [{ id: '22' }] } } } });
  await assert.rejects(trocarCodigoEValidarAtivos(soWaba, config, nenhum.fetch), { code: 'META_WABA_DIVERGENTE' });
  const dois = metaSimulada({ posseDe: { 11: { body: { data: [{ id: '20' }] } } } });
  await assert.rejects(trocarCodigoEValidarAtivos(soWaba, config, dois.fetch), { code: 'META_RELACAO_NAO_CONFIRMADA' });
  const naoConfirmada = metaSimulada({ posseDe: { 11: { body: { error: { message: 'permissão' } }, status: 403 } } });
  await assert.rejects(trocarCodigoEValidarAtivos(soWaba, config, naoConfirmada.fetch), { code: 'META_RELACAO_NAO_CONFIRMADA' }, 'o dono 10 não basta se a posse do 11 não foi confirmada');
  const semAlvos = metaSimulada({ debug: debugCom([{ scope: 'whatsapp_business_management', target_ids: ['20'] }, { scope: 'business_management' }]) });
  await assert.rejects(trocarCodigoEValidarAtivos(soWaba, config, semAlvos.fetch), { code: 'META_NEGOCIO_DIVERGENTE' });
  assert.deepEqual(semAlvos.etapas, ['oauth', 'debug']);
  const muitos = metaSimulada({ debug: debugCom([{ scope: 'whatsapp_business_management', target_ids: ['20'] }, { scope: 'business_management', target_ids: Array.from({ length: 11 }, (_, i) => String(100 + i)) }]) });
  await assert.rejects(trocarCodigoEValidarAtivos(soWaba, config, muitos.fetch), { code: 'META_RELACAO_NAO_CONFIRMADA' });
  assert.deepEqual(muitos.etapas, ['oauth', 'debug'], 'não consulta posse acima do limite');
});

test('D2: número sem prova → recusa (dois em coexistência, nenhum, lista paginada)', async () => {
  const dois = metaSimulada({ numeros: { data: [numeroOk, { ...numeroOk, id: '31' }] } });
  await assert.rejects(trocarCodigoEValidarAtivos(soWaba, config, dois.fetch), { code: 'META_NUMERO_AMBIGUO' });
  const nenhum = metaSimulada({ numeros: { data: [{ ...numeroOk, is_on_biz_app: false }] } });
  await assert.rejects(trocarCodigoEValidarAtivos(soWaba, config, nenhum.fetch), { code: 'META_COEXISTENCIA_NAO_CONFIRMADA' });
  const paginada = metaSimulada({ numeros: { data: [numeroOk], paging: { next: 'https://graph.facebook.com/next' } } });
  await assert.rejects(trocarCodigoEValidarAtivos(soWaba, config, paginada.fetch), { code: 'META_NUMERO_AMBIGUO' });
});

test('D2: só um dos ids no evento → o informado é conferido, o ausente é resolvido', async () => {
  const comNegocio = metaSimulada();
  const r1 = await trocarCodigoEValidarAtivos({ ...soWaba, businessId: '10' }, config, comNegocio.fetch);
  assert.deepEqual([r1.businessId, r1.phoneNumberId], ['10', '30']);
  assert.deepEqual(comNegocio.etapas, ['oauth', 'debug', 'posse', 'numeros', 'inscricao']);
  const negocioCruzado = metaSimulada();
  await assert.rejects(trocarCodigoEValidarAtivos({ ...soWaba, businessId: '11' }, config, negocioCruzado.fetch), { code: 'META_WABA_DIVERGENTE' });
  const comNumero = metaSimulada();
  const r2 = await trocarCodigoEValidarAtivos({ ...soWaba, phoneNumberId: '30' }, config, comNumero.fetch);
  assert.deepEqual([r2.businessId, r2.phoneNumberId], ['10', '30']);
});

/**
 * Integração com a #168: inscrição do app na WABA (`POST /{waba}/subscribed_apps`). É uma escrita externa e a última
 * etapa: só a WABA comprovada é inscrita. Recusa definitiva ≠ resultado incerto (a inscrição pode ter ocorrido).
 */
test('inscrição: nenhuma escrita externa quando a validação recusa antes (posse, número, coexistência)', async () => {
  const cruzada = metaSimulada();
  await assert.rejects(trocarCodigoEValidarAtivos({ ...entrada, businessId: '11' }, config, cruzada.fetch), { code: 'META_WABA_DIVERGENTE' });
  const semCoexistencia = metaSimulada({ numeros: { data: [{ ...numeroOk, is_on_biz_app: false }] } });
  await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, semCoexistencia.fetch), { code: 'META_COEXISTENCIA_NAO_CONFIRMADA' });
  const naoConfirmada = metaSimulada({ posse: { error: { message: 'permissão' } }, status: { posse: 403 } });
  await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, naoConfirmada.fetch), { code: 'META_RELACAO_NAO_CONFIRMADA' });
  for (const meta of [cruzada, semCoexistencia, naoConfirmada]) {
    assert.equal(meta.etapas.includes('inscricao'), false);
    assert.equal(meta.metodos.includes('POST'), false);
  }
});

test('inscrição recusada EXPLICITAMENTE → META_WEBHOOK_NAO_INSCRITO (2xx com success false; 4xx com objeto error)', async () => {
  const casos: [string, Respostas][] = [
    ['200 com success false', { inscricao: { success: false } }],
    ['400 com erro', { inscricao: { error: { code: 100 } }, status: { inscricao: 400 } }],
    ['403 com erro', { inscricao: { error: { code: 200 } }, status: { inscricao: 403 } }],
    ['429 com erro', { inscricao: { error: { code: 80007 } }, status: { inscricao: 429 } }],
  ];
  for (const [rotulo, respostas] of casos) {
    const meta = metaSimulada(respostas);
    await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, meta.fetch), { code: 'META_WEBHOOK_NAO_INSCRITO', httpStatus: 502 }, rotulo);
    assert.equal(meta.etapas.at(-1), 'inscricao', rotulo);
  }
});

test('inscrição com resultado DESCONHECIDO → META_WEBHOOK_INSCRICAO_INCERTA (a escrita pode ter ocorrido)', async () => {
  const casos: [string, Respostas][] = [
    ['500', { inscricao: { error: { message: 'interno' } }, status: { inscricao: 500 } }],
    ['503 sem corpo json', { inscricao: 'indisponível', status: { inscricao: 503 } }],
    ['200 com corpo ilegível', { inscricao: 'não é json' }],
    ['falha de rede', { inscricaoRede: true }],
    ['prazo esgotado', { inscricaoPrazo: true }],
    ['200 com objeto sem success', { inscricao: {} }],
    ['200 com null', { inscricao: null }],
    ['200 com array', { inscricao: [] }],
    ['200 com success string', { inscricao: { success: 'true' } }],
    ['200 com success número', { inscricao: { success: 1 } }],
    ['202 sem corpo', { inscricao: '', status: { inscricao: 202 } }],
    ['400 sem objeto error', { inscricao: 'Bad Request', status: { inscricao: 400 } }],
    ['404 com error string', { inscricao: { error: 'não encontrado' }, status: { inscricao: 404 } }],
  ];
  for (const [rotulo, respostas] of casos) {
    const meta = metaSimulada(respostas);
    await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, meta.fetch), { code: 'META_WEBHOOK_INSCRICAO_INCERTA', httpStatus: 502 }, rotulo);
  }
});

test('inscrição repetida (nova validação da mesma WABA) é a mesma chamada, sem estado local', async () => {
  const primeira = metaSimulada();
  const segunda = metaSimulada();
  await trocarCodigoEValidarAtivos(entrada, config, primeira.fetch);
  await trocarCodigoEValidarAtivos(entrada, config, segunda.fetch);
  assert.deepEqual(primeira.urls.at(-1), segunda.urls.at(-1));
  assert.equal(primeira.etapas.filter((e) => e === 'inscricao').length, 1);
  assert.equal(segunda.etapas.filter((e) => e === 'inscricao').length, 1);
});

/**
 * F1 (parecer da b99e205): os quatro controles da sonda do revisor. O provedor simulado APLICA a inscrição e só então
 * devolve HTTP 200 fora do contrato; JSON legível não comprova o resultado: a classificação tem de ser INCERTA.
 */
test('F1: 200 com success true confirma a inscrição (controle positivo da sonda)', async () => {
  const meta = metaSimulada({ inscricao: { success: true } });
  const r = await trocarCodigoEValidarAtivos(entrada, config, meta.fetch);
  assert.equal(r.webhookInscrito, true);
  assert.equal(meta.etapas.filter((e) => e === 'inscricao').length, 1);
});

for (const [nome, corpo] of [['objeto sem success', {}], ['null', null], ['array', []], ['success com tipo errado', { success: 'true' }]] as const) {
  test(`F1: HTTP 200 inesperado (${nome}) preserva a incerteza da escrita`, async () => {
    const meta = metaSimulada({ inscricao: corpo });
    await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, meta.fetch), { code: 'META_WEBHOOK_INSCRICAO_INCERTA', httpStatus: 502 });
    assert.equal(meta.etapas.filter((e) => e === 'inscricao').length, 1, 'a escrita foi enviada uma vez');
  });
}

test('inscrição tem prazo próprio (AbortSignal) na chamada', async () => {
  const meta = metaSimulada();
  await trocarCodigoEValidarAtivos(entrada, config, meta.fetch);
  assert.equal(meta.sinais.length, 1);
  assert.ok(meta.sinais[0] instanceof AbortSignal);
});
