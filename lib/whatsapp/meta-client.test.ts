import assert from 'node:assert/strict';
import test from 'node:test';
import { CORPO_NAO_LIDO, registroRecusaMeta, trocarCodigoEValidarAtivos } from './meta-client.ts';
import { exigirConfiguracaoWhatsappPrivada } from './configuracao.ts';

const config = exigirConfiguracaoWhatsappPrivada({
  KIDMAIS_DEPLOY_ENV: 'staging', META_APP_ID: '1', META_APP_SECRET: 'segredo-sintetico-valido',
  META_GRAPH_API_VERSION: 'v24.0', META_EMBEDDED_SIGNUP_CONFIG_ID: '2',
  META_OAUTH_REDIRECT_URI: 'https://staging.example.invalid/callback',
  META_EMBEDDED_SIGNUP_OPTIONS_JSON: '{"response_type":"code","override_default_response_type":true}',
  META_EMBEDDED_SIGNUP_EVENT_NAME: 'FINISH', META_EMBEDDED_SIGNUP_MESSAGE_ORIGINS: 'https://www.facebook.com',
});

/**
 * Modelo sintético (nenhuma chamada real): o token AUTORIZA a WABA 20 (whatsapp_business_management.target_ids), SEM
 * `business_management` (recusado na análise do app em 03/11). O DONO da WABA vem de `GET /{waba}?fields=id,
 * owner_business_info` com o token do cliente: WABA 20 é do negócio 10. O negócio do evento, se vier, só é conferido.
 */
const entrada = { code: 'codigo-sintetico', businessId: '10', wabaId: '20', phoneNumberId: '30' };
const escopos = ['whatsapp_business_management', 'whatsapp_business_messaging'];
const granularOk = [
  { scope: 'whatsapp_business_management', target_ids: ['20', '99'] },
  { scope: 'whatsapp_business_messaging', target_ids: ['20'] },
];
const donoOk = { id: '20', owner_business_info: { id: '10', name: 'Negócio sintético' } };
const numeroOk = { id: '30', display_phone_number: '+55 11 0000-0000', verified_name: 'Demo', is_on_biz_app: true };

type Etapa = 'oauth' | 'debug' | 'dono' | 'numeros' | 'inscricao';
type Respostas = { debug?: unknown; dono?: unknown; numeros?: unknown; inscricao?: unknown; inscricaoRede?: boolean; inscricaoPrazo?: boolean; status?: Partial<Record<Etapa, number>> };
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
    if (url.includes('owned_whatsapp_business_accounts')) throw new Error('a conexão não pode depender da aresta que exige business_management');
    const [etapa, body]: [Etapa, unknown] = url.includes('/oauth/access_token') ? ['oauth', { access_token: 'token-sintetico', token_type: 'bearer', expires_in: 3600 }]
      : url.includes('/debug_token') ? ['debug', r.debug ?? { data: { is_valid: true, app_id: '1', scopes: escopos, granular_scopes: granularOk } }]
        : url.includes('fields=id,owner_business_info') ? ['dono', 'dono' in r ? r.dono : donoOk]
          : ['numeros', r.numeros ?? { data: [numeroOk] }];
    etapas.push(etapa);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: r.status?.[etapa] || 200 });
  };
  return { etapas, urls, tokens, metodos, sinais, fetch: fetchMock as typeof fetch };
}
const debugCom = (granular: unknown, scopes: string[] = escopos) => ({ data: { is_valid: true, app_id: '1', scopes, granular_scopes: granular } });

test('combinação comprovada: WABA autorizada, dono lido no servidor = negócio informado, número da WABA, coexistência', async () => {
  const meta = metaSimulada();
  const result = await trocarCodigoEValidarAtivos(entrada, config, meta.fetch);
  assert.equal(result.accessToken, 'token-sintetico'); assert.equal(result.verifiedName, 'Demo');
  assert.equal(result.displayPhoneNumber, '+55 11 0000-0000');
  assert.deepEqual(meta.etapas, ['oauth', 'debug', 'dono', 'numeros', 'inscricao']);
  assert.equal(meta.urls[4], 'https://graph.facebook.com/v24.0/20/subscribed_apps');
  assert.deepEqual(meta.metodos, ['GET', 'GET', 'GET', 'GET', 'POST'], 'só a inscrição escreve na Meta, por último');
  assert.equal(result.webhookInscrito, true);
  assert.equal(meta.urls[2], 'https://graph.facebook.com/v24.0/20?fields=id,owner_business_info');
  assert.match(meta.urls[3], /\/v24\.0\/20\/phone_numbers\?/);
  assert.ok(meta.urls.every((url) => !url.includes('client_whatsapp_business_accounts')), 'não consulta a aresta do parceiro com o negócio do cliente');
  assert.deepEqual(meta.tokens.slice(2), ['Bearer token-sintetico', 'Bearer token-sintetico', 'Bearer token-sintetico'], 'dono, números e inscrição com o token do cliente');
  assert.deepEqual([result.businessId, result.phoneNumberId], ['10', '30'], 'ids informados e comprovados são devolvidos');
});

test('sem business_management: o token só com os escopos do WhatsApp conecta (análise do app de 03/11)', async () => {
  const meta = metaSimulada({ debug: debugCom(granularOk, ['public_profile', 'whatsapp_business_management', 'whatsapp_business_messaging']) });
  assert.equal((await trocarCodigoEValidarAtivos(entrada, config, meta.fetch)).businessId, '10');
  const comEscopoAntigo = metaSimulada({ debug: debugCom([...granularOk, { scope: 'business_management', target_ids: ['11'] }], [...escopos, 'business_management']) });
  assert.equal((await trocarCodigoEValidarAtivos(entrada, config, comEscopoAntigo.fetch)).businessId, '10', 'business_management, se ainda vier, não decide o negócio');
});

test('negócio do evento diferente do dono lido no servidor → recusa antes de consultar números', async () => {
  const meta = metaSimulada();
  await assert.rejects(trocarCodigoEValidarAtivos({ ...entrada, businessId: '11' }, config, meta.fetch), { code: 'META_WABA_DIVERGENTE', httpStatus: 409 });
  assert.deepEqual(meta.etapas, ['oauth', 'debug', 'dono']);
});

test('autorização: WABA fora dos ativos autorizados por este token é recusada antes de ler o dono', async () => {
  const wabaNao = metaSimulada({ debug: debugCom([{ scope: 'whatsapp_business_management', target_ids: ['77'] }]) });
  await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, wabaNao.fetch), { code: 'META_WABA_DIVERGENTE', httpStatus: 409 });
  assert.deepEqual(wabaNao.etapas, ['oauth', 'debug']);
});

test('escopo sem alvos explícitos não prova a autorização do ativo (fail-closed)', async () => {
  const semAlvoWaba = metaSimulada({ debug: debugCom([{ scope: 'whatsapp_business_management' }]) });
  await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, semAlvoWaba.fetch), { code: 'META_WABA_DIVERGENTE' });
  assert.deepEqual(semAlvoWaba.etapas, ['oauth', 'debug']);
});

test('dono ausente, de outra WABA ou não confirmado: recusa segura, sem consultar números', async () => {
  const casos: [string, Respostas][] = [
    ['Meta recusa a leitura (403)', { dono: { error: { message: 'permissão', code: 200 } }, status: { dono: 403 } }],
    ['campo inexistente (400)', { dono: { error: { message: 'campo', code: 100 } }, status: { dono: 400 } }],
    ['corpo de erro com 200', { dono: { error: { message: 'falha' } } }],
    ['campo ausente', { dono: { id: '20' } }],
    ['campo nulo', { dono: { id: '20', owner_business_info: null } }],
    ['dono sem id', { dono: { id: '20', owner_business_info: { name: 'sem id' } } }],
    ['id do dono não numérico', { dono: { id: '20', owner_business_info: { id: 'abc' } } }],
    ['corpo de outra WABA', { dono: { id: '21', owner_business_info: { id: '10' } } }],
    ['corpo sem id da WABA', { dono: { owner_business_info: { id: '10' } } }],
    ['corpo inválido', { dono: 'não é json' }],
    ['corpo nulo', { dono: null }],
  ];
  for (const [rotulo, respostas] of casos) {
    const meta = metaSimulada(respostas);
    await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, meta.fetch), { code: 'META_RELACAO_NAO_CONFIRMADA', httpStatus: 409 }, rotulo);
    assert.deepEqual(meta.etapas, ['oauth', 'debug', 'dono'], rotulo);
  }
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
  for (const etapa of ['oauth', 'debug', 'dono', 'numeros'] as const) {
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
 * resolvidos no servidor e COMPROVADOS: dono = `owner_business_info` da WABA autorizada; número = o único da WABA em
 * coexistência. Nunca o primeiro da lista ou a ordem.
 */
const soWaba = { code: 'codigo-sintetico', wabaId: '20' };

test('D2: só waba_id → negócio dono lido no servidor e o único número em coexistência', async () => {
  const meta = metaSimulada({ numeros: { data: [{ ...numeroOk, id: '29', is_on_biz_app: false }, numeroOk] } });
  const result = await trocarCodigoEValidarAtivos(soWaba, config, meta.fetch);
  assert.deepEqual([result.businessId, result.phoneNumberId, result.verifiedName], ['10', '30', 'Demo']);
  assert.deepEqual(meta.etapas, ['oauth', 'debug', 'dono', 'numeros', 'inscricao']);
});

test('D2: dono sem prova → recusa (campo ausente, Meta recusa)', async () => {
  const ausente = metaSimulada({ dono: { id: '20' } });
  await assert.rejects(trocarCodigoEValidarAtivos(soWaba, config, ausente.fetch), { code: 'META_RELACAO_NAO_CONFIRMADA' });
  const recusa = metaSimulada({ dono: { error: { message: 'permissão' } }, status: { dono: 403 } });
  await assert.rejects(trocarCodigoEValidarAtivos(soWaba, config, recusa.fetch), { code: 'META_RELACAO_NAO_CONFIRMADA' });
  assert.deepEqual(recusa.etapas, ['oauth', 'debug', 'dono']);
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
  assert.deepEqual(comNegocio.etapas, ['oauth', 'debug', 'dono', 'numeros', 'inscricao']);
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
test('inscrição: nenhuma escrita externa quando a validação recusa antes (dono, número, coexistência)', async () => {
  const cruzada = metaSimulada();
  await assert.rejects(trocarCodigoEValidarAtivos({ ...entrada, businessId: '11' }, config, cruzada.fetch), { code: 'META_WABA_DIVERGENTE' });
  const semCoexistencia = metaSimulada({ numeros: { data: [{ ...numeroOk, is_on_biz_app: false }] } });
  await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, semCoexistencia.fetch), { code: 'META_COEXISTENCIA_NAO_CONFIRMADA' });
  const naoConfirmada = metaSimulada({ dono: { error: { message: 'permissão' } }, status: { dono: 403 } });
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

/**
 * Troca do código (03/11/2026): a tentativa real em staging (23:27Z) parou em META_API_RECUSOU; causa provável, o envio de
 * `redirect_uri` na troca. A troca documentada do Embedded Signup (Tech Provider) usa só client_id, client_secret e code.
 */
test('troca do código: só client_id, client_secret e code — sem redirect_uri', async () => {
  const meta = metaSimulada();
  await trocarCodigoEValidarAtivos(entrada, config, meta.fetch);
  const troca = new URL(meta.urls[0]);
  assert.equal(troca.origin + troca.pathname, 'https://graph.facebook.com/v24.0/oauth/access_token');
  assert.deepEqual([...troca.searchParams.keys()].sort(), ['client_id', 'client_secret', 'code']);
  assert.equal(troca.searchParams.get('code'), 'codigo-sintetico');
  assert.equal(troca.searchParams.get('client_id'), '1');
  assert.ok(!meta.urls[0].includes('example.invalid'), 'o redirect configurado não vai para a Meta');
});

/** Registro seguro: só etapa, inteiros e listas fechadas; nenhum texto vindo da Meta (message, type fora da lista, fbtrace). */
const SEGREDOS = ['codigo-sintetico', 'segredo-sintetico-valido', 'token-sintetico', 'example.invalid', 'redirect_uri', 'mensagem-com-dado', 'AbC_12-x', 'fbtrace'];
const erroMeta = { error: { message: 'mensagem-com-dado redirect_uri https://staging.example.invalid/callback', type: 'OAuthException', code: 100, error_subcode: 36008, fbtrace_id: 'AbC_12-x' } };
type Falha = 'oauth' | 'debug' | 'dono' | 'numeros';
function metaRecusando(etapaQueFalha: Falha, resposta: () => Response) {
  const ok = metaSimulada();
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const etapa = url.includes('/oauth/access_token') ? 'oauth' : url.includes('/debug_token') ? 'debug' : url.includes('owner_business_info') ? 'dono' : url.includes('/phone_numbers') ? 'numeros' : 'outra';
    if (etapa === etapaQueFalha) return resposta();
    return ok.fetch(input, init);
  }) as typeof fetch;
}
const json = (corpo: unknown, status: number) => () => new Response(typeof corpo === 'string' ? corpo : JSON.stringify(corpo), { status });
const ETAPA: Record<Falha, string> = { oauth: 'troca_codigo', debug: 'debug_token', dono: 'dono_waba', numeros: 'numeros' };
type Avisos = { mock: { resetCalls(): void; callCount(): number; calls: { arguments: unknown[] }[] } };

async function umRegistro(avisos: Avisos, promessa: Promise<unknown>, codigo: string, rotulo: string) {
  avisos.mock.resetCalls();
  await assert.rejects(promessa, { code: codigo }, rotulo);
  assert.equal(avisos.mock.callCount(), 1, `${rotulo}: um registro`);
  assert.equal(avisos.mock.calls[0].arguments.length, 1);
  const linha = String(avisos.mock.calls[0].arguments[0]);
  for (const s of SEGREDOS) assert.ok(!linha.includes(s), `${rotulo}: ${s} fora do log`);
  return JSON.parse(linha).whatsappMetaRecusa as Record<string, unknown>;
}

test('recusa da Meta (4xx com erro) registra etapa, inteiros e tipo da lista, sem texto da Meta', async (t) => {
  const avisos = t.mock.method(console, 'warn', () => {});
  for (const falha of ['oauth', 'debug', 'numeros', 'dono'] as const) {
    const codigo = falha === 'dono' ? 'META_RELACAO_NAO_CONFIRMADA' : 'META_API_RECUSOU';
    const r = await umRegistro(avisos, trocarCodigoEValidarAtivos(entrada, config, metaRecusando(falha, json(erroMeta, 400))), codigo, falha);
    assert.deepEqual(r, { etapa: ETAPA[falha], http: 400, corpo: 'com_erro', codigo: 100, subcodigo: 36008, tipo: 'OAuthException' });
  }
});

test('HTTP 200 com error e corpo ilegível também registram, nas quatro etapas', async (t) => {
  const avisos = t.mock.method(console, 'warn', () => {});
  for (const falha of ['oauth', 'debug', 'numeros', 'dono'] as const) {
    const codigo = falha === 'dono' ? 'META_RELACAO_NAO_CONFIRMADA' : 'META_API_RECUSOU';
    const com200 = await umRegistro(avisos, trocarCodigoEValidarAtivos(entrada, config, metaRecusando(falha, json(erroMeta, 200))), codigo, `${falha} 200+error`);
    assert.deepEqual([com200.etapa, com200.http, com200.corpo, com200.codigo], [ETAPA[falha], 200, 'com_erro', 100]);
    const ilegivel = await umRegistro(avisos, trocarCodigoEValidarAtivos(entrada, config, metaRecusando(falha, json('<html>mensagem-com-dado</html>', 400))), codigo, `${falha} ilegível`);
    assert.deepEqual(ilegivel, { etapa: ETAPA[falha], http: 400, corpo: 'ilegivel', codigo: null, subcodigo: null, tipo: null });
  }
});

test('dono 5xx: recusa pelo status, sem esperar o corpo (que pode nunca terminar)', async (t) => {
  const avisos = t.mock.method(console, 'warn', () => {});
  const pendente = () => new Response(new ReadableStream({ start() { /* nunca envia nem fecha */ } }), { status: 503 });
  let relogio: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise((_, rejeitar) => { relogio = setTimeout(() => rejeitar(new Error('esperou o corpo do 5xx')), 2000); });
  try {
    const r = await umRegistro(avisos, Promise.race([trocarCodigoEValidarAtivos(entrada, config, metaRecusando('dono', pendente)), prazo]), 'META_API_RECUSOU', 'dono 503 pendente');
    assert.deepEqual(r, { etapa: 'dono_waba', http: 503, corpo: 'nao_lido', codigo: null, subcodigo: null, tipo: null });
  } finally { clearTimeout(relogio); }
  const comErro = await umRegistro(avisos, trocarCodigoEValidarAtivos(entrada, config, metaRecusando('dono', json(erroMeta, 500))), 'META_API_RECUSOU', 'dono 500');
  assert.equal(comErro.corpo, 'nao_lido', 'nem o corpo pronto do 5xx é lido');
});

test('sucesso e recusas locais (sem erro da Meta) não registram recusa da Meta', async (t) => {
  const avisos = t.mock.method(console, 'warn', () => {});
  await trocarCodigoEValidarAtivos(entrada, config, metaSimulada().fetch);
  await assert.rejects(trocarCodigoEValidarAtivos(entrada, config, metaSimulada({ dono: { id: '20' } }).fetch), { code: 'META_RELACAO_NAO_CONFIRMADA' });
  assert.equal(avisos.mock.callCount(), 0);
});

test('registroRecusaMeta: tipo só da lista fechada; inteiros com limites; fbtrace e textos nunca saem', () => {
  const r = (body: unknown, http = 400) => registroRecusaMeta('troca_codigo', http, body).whatsappMetaRecusa;
  // Textos que passariam por um filtro de alfabeto (nome, telefone) não saem: tipo vira 'outro', fbtrace não existe.
  const pessoal = r({ error: { type: 'MariaSilva', fbtrace_id: '5511999999999', code: 1 } });
  assert.deepEqual(pessoal, { etapa: 'troca_codigo', http: 400, corpo: 'com_erro', codigo: 1, subcodigo: null, tipo: 'outro' });
  assert.ok(!JSON.stringify(pessoal).includes('Maria') && !JSON.stringify(pessoal).includes('5511999999999'));
  for (const tipo of ['OAuthException', 'GraphMethodException', 'FacebookApiException', 'GraphBatchException']) assert.equal(r({ error: { type: tipo } }).tipo, tipo);
  for (const tipo of ['oauthexception', 'OAuthException ', 'x'.repeat(41), 123, null, {}]) assert.equal(r({ error: { type: tipo } }).tipo, 'outro', String(tipo));
  assert.equal(r({ error: {} }).tipo, null, 'sem type: null');
  // Inteiros: 0 e 999.999.999 entram; negativos, frações, 1e9, strings, NaN e Infinity viram null.
  assert.deepEqual([r({ error: { code: 0 } }).codigo, r({ error: { code: 999_999_999 } }).codigo], [0, 999_999_999]);
  for (const v of [-1, 1.5, 1_000_000_000, '100', Number.NaN, Infinity]) {
    assert.equal(r({ error: { code: v, error_subcode: v } }).codigo, null, String(v));
    assert.equal(r({ error: { code: v, error_subcode: v } }).subcodigo, null, String(v));
  }
  assert.equal(r({}, 1_000_000_000).http, null);
  assert.equal(r(null, 502).corpo, 'ilegivel');
  assert.equal(r({ data: [] }, 200).corpo, 'sem_erro');
  assert.equal(r({ error: 'texto' }).codigo, null);
  assert.equal(r(CORPO_NAO_LIDO, 503).corpo, 'nao_lido');
  assert.ok(!('fbtrace' in r(erroMeta)), 'fbtrace não faz parte do registro');
});
