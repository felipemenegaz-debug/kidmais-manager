import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';
import type { TenantComprovado } from '../saas/provar-tenant.ts';
import {
  ATIVOS_TESTE, AVISO_IS_ON_BIZ_APP, INTERVALO_MINIMO_MS, PRAZO_LEITURA_MS, SERVICO_WEB_STAGING, comPrazo, demoVisivelPara, exigirRequisicaoSemParametros,
  requisitoIsOnBizApp, travaDemoAtivosTeste, verificarAtivosTeste, type DepsDemo,
} from './demo-ativos-teste.ts';

/** Tudo sintético: nenhum token real, nenhuma chamada à Meta, nenhum banco. */
const EMPRESA = randomUUID(), USUARIO = randomUUID();
const TOKEN = 'TOKENSINTETICO0123456789abcdef';
const envOk = (): Record<string, string | undefined> => ({
  RENDER: 'true', RENDER_SERVICE_ID: SERVICO_WEB_STAGING, KIDMAIS_DEPLOY_ENV: 'staging', META_DEMO_ATIVOS_TESTE: 'true',
  META_DEMO_EMPRESA_ID: EMPRESA, META_DEMO_USUARIO_ID: USUARIO, META_DEMO_ACCESS_TOKEN: TOKEN, META_GRAPH_API_VERSION: 'v26.0',
});
const tenantDe = (o: Partial<TenantComprovado> = {}): TenantComprovado => ({ empresaComprovada: EMPRESA, membershipId: randomUUID(), usuarioId: USUARIO, papelAtual: 'REPRESENTANTE_AUTORIZADO', ...o });

type Chamada = { url: string; method: string; auth: string | null };
function graphFalso(respostas: { posse?: { status?: number; body: unknown }; numeros?: { status?: number; body: unknown }; rede?: boolean } = {}) {
  const chamadas: Chamada[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET';
    chamadas.push({ url, method, auth: new Headers(init?.headers).get('authorization') });
    if (respostas.rede) throw new TypeError('fetch failed');
    const r = url.includes('/owned_whatsapp_business_accounts') ? (respostas.posse ?? { body: { data: [{ id: ATIVOS_TESTE.wabaId }] } })
      : url.includes('/phone_numbers') ? (respostas.numeros ?? { body: { data: [{ id: ATIVOS_TESTE.phoneNumberId, display_phone_number: '+1 555-198-0405', verified_name: 'Test Number', is_on_biz_app: false }] } })
        : { status: 500, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { chamadas, fetchImpl };
}
function deps(o: { env?: Record<string, string | undefined>; tenant?: TenantComprovado | Error; graph?: { chamadas: Chamada[]; fetchImpl: typeof fetch }; agora?: number; ultimas?: Map<string, number>; prazoMs?: number } = {}) {
  const logs: Record<string, unknown>[] = [], queries: string[] = [];
  const graph = o.graph ?? graphFalso();
  const d: DepsDemo = {
    env: o.env ?? envOk(),
    transacao: async (work) => work({ query: async (sql: string) => { queries.push(sql); return { rows: [] }; } } as never),
    provar: async () => { if (o.tenant instanceof Error) throw o.tenant; return o.tenant ?? tenantDe(); },
    revalidar: async () => undefined,
    fetchImpl: graph.fetchImpl, prazoMs: o.prazoMs, agora: () => o.agora ?? 1_000_000, log: (l) => { logs.push(l); }, ultimas: o.ultimas ?? new Map(),
  };
  return { d, logs, queries, graph };
}
const sessao = (usuario: string = USUARIO) => ({ usuario_id: usuario, papel: 'REPRESENTANTE_AUTORIZADO' });
const codigo = (c: string, status: number) => (e: { code?: string; httpStatus?: number }) => e.code === c && e.httpStatus === status;

test('trava: libera só o conjunto exato do web de staging; qualquer ausência ou divergência bloqueia', () => {
  assert.equal(travaDemoAtivosTeste(envOk()).liberada, true);
  const casos: [string, Record<string, string | undefined>][] = [
    ['sem RENDER', { RENDER: undefined }], ['RENDER=1', { RENDER: '1' }], ['RENDER maiúsculo', { RENDER: 'TRUE' }],
    ['serviço de produção', { RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg' }], ['cron de staging', { RENDER_SERVICE_ID: 'crn-db493i142hec73ahmoe0' }],
    ['serviço ausente', { RENDER_SERVICE_ID: undefined }], ['serviço com espaço', { RENDER_SERVICE_ID: ` ${SERVICO_WEB_STAGING}` }],
    ['deploy production', { KIDMAIS_DEPLOY_ENV: 'production' }], ['deploy Staging', { KIDMAIS_DEPLOY_ENV: 'Staging' }], ['deploy com espaço', { KIDMAIS_DEPLOY_ENV: 'staging ' }],
    ['deploy ausente', { KIDMAIS_DEPLOY_ENV: undefined }], ['flag ausente', { META_DEMO_ATIVOS_TESTE: undefined }], ['flag 1', { META_DEMO_ATIVOS_TESTE: '1' }],
    ['empresa ausente', { META_DEMO_EMPRESA_ID: undefined }], ['empresa inválida', { META_DEMO_EMPRESA_ID: 'empresa' }], ['usuário ausente', { META_DEMO_USUARIO_ID: '' }],
    ['token ausente', { META_DEMO_ACCESS_TOKEN: undefined }], ['token curto', { META_DEMO_ACCESS_TOKEN: 'abc' }], ['token com espaço', { META_DEMO_ACCESS_TOKEN: `${TOKEN} x` }],
    ['versão Graph ausente', { META_GRAPH_API_VERSION: undefined }], ['versão Graph inválida', { META_GRAPH_API_VERSION: '26' }],
  ];
  for (const [nome, delta] of casos) assert.equal(travaDemoAtivosTeste({ ...envOk(), ...delta }).liberada, false, nome);
});

test('trava ignora NODE_ENV: produção com NODE_ENV=development continua bloqueada; staging com NODE_ENV=production continua liberada', () => {
  assert.equal(travaDemoAtivosTeste({ ...envOk(), RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', NODE_ENV: 'development' }).liberada, false);
  assert.equal(travaDemoAtivosTeste({ ...envOk(), NODE_ENV: 'production' }).liberada, true);
});

test('visibilidade: só a Gestão da empresa de revisão logada com o usuário de revisão', () => {
  const trava = travaDemoAtivosTeste(envOk());
  assert.equal(demoVisivelPara(trava, tenantDe(), USUARIO), true);
  assert.equal(demoVisivelPara(trava, tenantDe({ empresaComprovada: randomUUID() }), USUARIO), false, 'Gestão de outra empresa');
  assert.equal(demoVisivelPara(trava, tenantDe({ usuarioId: randomUUID() }), USUARIO), false, 'outro usuário');
  assert.equal(demoVisivelPara(trava, tenantDe(), randomUUID()), false, 'sessão de outro usuário');
  assert.equal(demoVisivelPara(trava, tenantDe({ papelAtual: 'ADMINISTRATIVO' }), USUARIO), false, 'sem Gestão');
  assert.equal(demoVisivelPara(travaDemoAtivosTeste({ ...envOk(), META_DEMO_ATIVOS_TESTE: undefined }), tenantDe(), USUARIO), false, 'desligada');
});

test('requisição com corpo ou query é recusada (400); nenhum id vem do navegador', () => {
  assert.doesNotThrow(() => exigirRequisicaoSemParametros('', ''));
  assert.throws(() => exigirRequisicaoSemParametros('?wabaId=123', ''), codigo('DEMO_PARAMETROS_RECUSADOS', 400));
  assert.throws(() => exigirRequisicaoSemParametros('', JSON.stringify({ wabaId: '999', businessId: '1' })), codigo('DEMO_PARAMETROS_RECUSADOS', 400));
  assert.throws(() => exigirRequisicaoSemParametros('', '{}'), codigo('DEMO_PARAMETROS_RECUSADOS', 400));
});

test('bloqueios respondem 404 e não chamam a Meta: trava, outra empresa, outro usuário, sem Gestão, empresa não comprovada', async () => {
  const cenarios: [string, Parameters<typeof deps>[0], string][] = [
    ['ambiente', { env: { ...envOk(), RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg' } }, USUARIO],
    ['outra empresa', { tenant: tenantDe({ empresaComprovada: randomUUID() }) }, USUARIO],
    ['outro usuário da mesma empresa', { tenant: tenantDe({ usuarioId: randomUUID() }) }, USUARIO],
    ['sem Gestão', { tenant: tenantDe({ papelAtual: 'ADMINISTRATIVO' }) }, USUARIO],
    ['empresa não comprovada', { tenant: new PacoteAdminError('TENANT_NAO_COMPROVADO', 'x', 403) }, USUARIO],
  ];
  for (const [nome, o, usuario] of cenarios) {
    const { d, graph, queries } = deps(o);
    await assert.rejects(verificarAtivosTeste(sessao(usuario), d), codigo('NAO_ENCONTRADO', 404), nome);
    assert.equal(graph.chamadas.length, 0, `${nome}: nenhuma chamada à Meta`);
    assert.deepEqual(queries, [], `${nome}: nenhuma consulta própria ao banco`);
  }
});

test('leitura aprovada: pertencimento + números com GET apenas, token só no cabeçalho, requisito não atendido e aviso fixo', async () => {
  const { d, graph, logs, queries } = deps();
  const r = await verificarAtivosTeste(sessao(), d);
  assert.deepEqual(r.portfolio, { id: ATIVOS_TESTE.businessId, possuiWabaTeste: true });
  assert.equal(r.waba.id, ATIVOS_TESTE.wabaId);
  assert.equal(r.numeroTestePresente, true);
  assert.equal(r.requisitoKidmaisIsOnBizApp, 'nao_atendido');
  assert.equal(r.aviso, AVISO_IS_ON_BIZ_APP);
  assert.equal('elegivelCoexistencia' in r, false);
  assert.deepEqual(graph.chamadas.map((c) => c.method), ['GET', 'GET']);
  assert.match(graph.chamadas[0].url, new RegExp(`/v26\\.0/${ATIVOS_TESTE.businessId}/owned_whatsapp_business_accounts\\?`));
  assert.match(graph.chamadas[1].url, new RegExp(`/v26\\.0/${ATIVOS_TESTE.wabaId}/phone_numbers\\?fields=.*is_on_biz_app`));
  assert.ok(graph.chamadas.every((c) => c.auth === `Bearer ${TOKEN}` && !c.url.includes(TOKEN)));
  assert.ok(!graph.chamadas.some((c) => /subscribed_apps|\/messages|oauth\/access_token|debug_token/.test(c.url)));
  assert.equal(JSON.stringify(r).includes(TOKEN), false);
  assert.equal(JSON.stringify(logs).includes(TOKEN), false);
  assert.deepEqual(queries, []);
});

test('WABA fora do portfólio: possuiWabaTeste=false e números não são lidos', async () => {
  const graph = graphFalso({ posse: { body: { data: [{ id: '777' }] } } });
  const { d } = deps({ graph });
  const r = await verificarAtivosTeste(sessao(), d);
  assert.equal(r.portfolio.possuiWabaTeste, false);
  assert.deepEqual(r.numeros, []);
  assert.equal(r.requisitoKidmaisIsOnBizApp, 'nao_informado');
  assert.equal(graph.chamadas.length, 1);
});

test('is_on_biz_app: true → atendido, false → não atendido, ausente → não informado (só o atributo)', () => {
  assert.equal(requisitoIsOnBizApp({ is_on_biz_app: true }), 'atendido');
  assert.equal(requisitoIsOnBizApp({ is_on_biz_app: false }), 'nao_atendido');
  assert.equal(requisitoIsOnBizApp({}), 'nao_informado');
  assert.equal(requisitoIsOnBizApp({ is_on_biz_app: 'true' }), 'nao_informado');
  assert.equal(requisitoIsOnBizApp(undefined), 'nao_informado');
});

test('recusa da Meta, 5xx ou rede: erro seguro 502 sem token nem mensagem original', async () => {
  for (const graph of [graphFalso({ posse: { status: 403, body: { error: { code: 200, message: `token ${TOKEN}` } } } }), graphFalso({ posse: { status: 500, body: {} } }),
    graphFalso({ numeros: { status: 400, body: { error: { code: 100 } } } }), graphFalso({ rede: true })]) {
    const { d, logs } = deps({ graph });
    await assert.rejects(verificarAtivosTeste(sessao(), d), (e: { code?: string; httpStatus?: number; message?: string }) => e.code === 'DEMO_META_RECUSOU' && e.httpStatus === 502 && !String(e.message).includes(TOKEN));
    assert.equal(JSON.stringify(logs).includes(TOKEN), false);
    assert.ok(graph.chamadas.every((c) => c.method === 'GET'));
  }
});

test('frequência: segunda consulta em menos de 30 s responde 429 sem chamar a Meta', async () => {
  const ultimas = new Map<string, number>();
  const primeira = deps({ ultimas, agora: 1_000_000 });
  await verificarAtivosTeste(sessao(), primeira.d);
  const segunda = deps({ ultimas, agora: 1_000_000 + INTERVALO_MINIMO_MS - 1 });
  await assert.rejects(verificarAtivosTeste(sessao(), segunda.d), codigo('DEMO_AGUARDE', 429));
  assert.equal(segunda.graph.chamadas.length, 0);
  const terceira = deps({ ultimas, agora: 1_000_000 + INTERVALO_MINIMO_MS });
  await verificarAtivosTeste(sessao(), terceira.d);
});

/**
 * PRAZO (não frequência): resposta que nunca chega e corpo que nunca termina, sem rede real. O corpo pendurado ignora o
 * cancelamento de propósito: a corrida com o prazo precisa encerrar mesmo assim.
 */
function graphPendurado(etapa: 'posse' | 'numeros', modo: 'resposta' | 'corpo') {
  const chamadas: Chamada[] = [];
  const abortados: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    chamadas.push({ url, method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization') });
    init?.signal?.addEventListener('abort', () => { abortados.push(url); });
    const alvo = etapa === 'posse' ? url.includes('/owned_whatsapp_business_accounts') : url.includes('/phone_numbers');
    if (!alvo) return new Response(JSON.stringify({ data: [{ id: ATIVOS_TESTE.wabaId }] }), { status: 200 });
    if (modo === 'resposta') return new Promise<Response>(() => undefined);
    const corpo = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"data":[')); } });
    return new Response(corpo, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { chamadas, abortados, fetchImpl };
}

test('prazo é distinto do limitador de frequência e cobre a leitura (8 s) separadamente dos 30 s entre consultas', () => {
  assert.equal(PRAZO_LEITURA_MS, 8_000);
  assert.equal(INTERVALO_MINIMO_MS, 30_000);
  assert.ok(PRAZO_LEITURA_MS < INTERVALO_MINIMO_MS);
});

test('resposta pendurada: o prazo aborta a chamada e responde 504 genérico, sem token e sem ler números', async () => {
  for (const etapa of ['posse', 'numeros'] as const) {
    const graph = graphPendurado(etapa, 'resposta');
    const { d, logs } = deps({ graph, prazoMs: 30 });
    const inicio = Date.now();
    await assert.rejects(verificarAtivosTeste(sessao(), d), (e: { code?: string; httpStatus?: number; message?: string }) =>
      e.code === 'DEMO_META_SEM_RESPOSTA' && e.httpStatus === 504 && !String(e.message).includes(TOKEN));
    assert.ok(Date.now() - inicio < 2_000, 'encerra pelo prazo, não espera a Meta');
    assert.ok(graph.abortados.length >= 1, 'a chamada pendurada recebe o cancelamento');
    assert.equal(graph.chamadas.length, etapa === 'posse' ? 1 : 2);
    assert.deepEqual(logs.at(-1), { resultado: 'DEMO_META_SEM_RESPOSTA' });
    assert.equal(JSON.stringify(logs).includes(TOKEN), false);
  }
});

test('corpo pendurado (cabeçalhos chegam, o JSON nunca termina): o prazo também encerra, com 504 genérico', async () => {
  for (const etapa of ['posse', 'numeros'] as const) {
    const graph = graphPendurado(etapa, 'corpo');
    const { d } = deps({ graph, prazoMs: 30 });
    await assert.rejects(verificarAtivosTeste(sessao(), d), (e: { code?: string; httpStatus?: number }) => e.code === 'DEMO_META_SEM_RESPOSTA' && e.httpStatus === 504);
    assert.ok(graph.abortados.length >= 1);
  }
});

test('comPrazo: dentro do prazo devolve o resultado e não deixa relógio pendente; o sinal chega ao fetch', async () => {
  let sinal: AbortSignal | undefined;
  const fetchImpl = (async (_i: string | URL, init?: RequestInit) => { sinal = init?.signal ?? undefined; return new Response('{"ok":true}'); }) as typeof fetch;
  const r = await comPrazo(1_000, fetchImpl, async (f) => (await f('https://graph.facebook.com/v26.0/x')).json());
  assert.deepEqual(r, { ok: true });
  assert.ok(sinal instanceof AbortSignal);
  assert.equal(sinal.aborted, false);
});
