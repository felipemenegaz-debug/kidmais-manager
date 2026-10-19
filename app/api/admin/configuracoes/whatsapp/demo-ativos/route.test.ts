import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as crypto from 'node:crypto';
import * as errosCliente from '../../../../../../lib/clientes/services/errors.ts';
import * as pacotesAdmin from '../../../../../../lib/comercial/pacotes-admin.ts';
import * as origemAdmin from '../../../../../../lib/http/admin-origin.ts';
import * as senha from '../../../../../../lib/autenticacao/senha.ts';
import * as erros from '../../../../../../lib/whatsapp/errors.ts';
import * as demo from '../../../../../../lib/whatsapp/demo-ativos-teste.ts';
import type { TenantComprovado } from '../../../../../../lib/saas/provar-tenant.ts';

/**
 * ROTA HTTP REAL: `route.ts`, `lib/whatsapp/http.ts` e `lib/http/admin-crm-api.ts` (sessão, origem, CSRF e
 * paywall na ordem real) são transpilados e executados. Interceptados: só o banco (consulta de sessão e atividade),
 * o paywall e a Meta (fetch falso). Nenhum SQL, rede ou token real.
 */
const requireModule = createRequire(import.meta.url);
const raiz = new URL('../../../../../../', import.meta.url);
const ORIGEM = 'http://localhost:3000';
const URL_ROTA = `${ORIGEM}/api/admin/configuracoes/whatsapp/demo-ativos`;
const COOKIE = 'kidmais_admin_dev';
const TOKEN_SESSAO = 'S'.repeat(43), CSRF = 'csrf-sintetico-da-sessao';
const EMPRESA = randomUUID(), USUARIO = randomUUID(), TOKEN_META = 'TOKENSINTETICO0123456789abcdef';
const envOk = { RENDER: 'true', RENDER_SERVICE_ID: demo.SERVICO_WEB_STAGING, KIDMAIS_DEPLOY_ENV: 'staging', META_DEMO_ATIVOS_TESTE: 'true',
  META_DEMO_EMPRESA_ID: EMPRESA, META_DEMO_USUARIO_ID: USUARIO, META_DEMO_ACCESS_TOKEN: TOKEN_META, META_GRAPH_API_VERSION: 'v26.0' };

function transpilar(caminho: string, dependencias: (id: string) => unknown) {
  const code = ts.transpileModule(readFileSync(new URL(caminho, raiz), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function('require', 'exports', code)((id: string) => {
    const dep = dependencias(id);
    if (dep === undefined) throw new Error(`Dependência não interceptada em ${caminho}: ${id}`);
    return dep;
  }, exports);
  return exports;
}

type Cenario = { env?: Record<string, string | undefined>; tenant?: Partial<TenantComprovado>; usuarioSessao?: string; paywall402?: boolean };
function rota(c: Cenario = {}) {
  const sql: string[] = [], graph: { url: string; method: string }[] = [];
  let sessoesConsultadas = 0;
  const authError = (message = 'Autenticação administrativa necessária.', status = 401) => new errosCliente.ClienteServiceError('AUTENTICACAO_ADMINISTRATIVA', message, status);
  const adminCrm = transpilar('lib/http/admin-crm-api.ts', (id) => ({
    'node:crypto': crypto,
    '../autenticacao/service': {
      authError,
      // Mesmo contrato da consulta real: token de 43 caracteres e sessão viva; senão 401.
      consultarSessao: async (token: string) => {
        sessoesConsultadas++;
        if (token !== TOKEN_SESSAO) throw authError();
        return { id: 'sessao-sintetica', usuario_id: c.usuarioSessao ?? USUARIO, papel: 'REPRESENTANTE_AUTORIZADO', csrf_hash: senha.hashToken(CSRF), empresa_ativa_id: EMPRESA };
      },
    },
    '../autenticacao/senha': senha,
    '../db/postgres': { db: () => ({ query: async (texto: string) => { sql.push(texto); return { rows: [] }; } }) },
    '../assinatura/paywall.ts': { exigirAcessoComercial: async () => { if (c.paywall402) throw new errosCliente.ClienteServiceError('ASSINATURA_NECESSARIA', 'Assinatura necessária.', 402); } },
    './admin-origin.ts': origemAdmin,
  } as Record<string, unknown>)[id]);
  const http = transpilar('lib/whatsapp/http.ts', (id) => ({
    'next/server': requireModule('next/server'),
    '../comercial/pacotes-admin.ts': pacotesAdmin,
    '../clientes/services/errors.ts': errosCliente,
    '../http/api-response.ts': { apiErrorResponse: (e: { message: string; code: string; httpStatus: number }) => requireModule('next/server').NextResponse.json({ ok: false, erro: e.message, codigo: e.code }, { status: e.httpStatus }) },
    './errors.ts': erros,
  } as Record<string, unknown>)[id]);
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input); graph.push({ url, method: init?.method ?? 'GET' });
    const body = url.includes('/owned_whatsapp_business_accounts') ? { data: [{ id: demo.ATIVOS_TESTE.wabaId }] }
      : { data: [{ id: demo.ATIVOS_TESTE.phoneNumberId, display_phone_number: '+1 555-198-0405', verified_name: 'Test Number', is_on_biz_app: false }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const tenant: TenantComprovado = { empresaComprovada: EMPRESA, membershipId: randomUUID(), usuarioId: c.usuarioSessao ?? USUARIO, papelAtual: 'REPRESENTANTE_AUTORIZADO', ...c.tenant };
  const env = c.env ?? envOk;
  const demoInterceptado = {
    exigirRequisicaoSemParametros: demo.exigirRequisicaoSemParametros,
    travaDemoAtivosTeste: () => demo.travaDemoAtivosTeste(env),
    verificarAtivosTeste: (sessao: { usuario_id: string; papel: string }) => demo.verificarAtivosTeste(sessao, {
      env, transacao: async (work) => work({ query: async () => ({ rows: [] }) } as never),
      provar: async () => tenant, revalidar: async () => undefined, fetchImpl, log: () => undefined, ultimas: new Map(),
    }),
  };
  const route = transpilar('app/api/admin/configuracoes/whatsapp/demo-ativos/route.ts', (id) => ({
    'next/server': requireModule('next/server'),
    '@/lib/http/admin-crm-api.ts': adminCrm,
    '@/lib/whatsapp/demo-ativos-teste.ts': demoInterceptado,
    '@/lib/whatsapp/errors.ts': erros,
    '@/lib/whatsapp/http.ts': http,
  } as Record<string, unknown>)[id]) as { POST: (r: unknown) => Promise<Response> };
  return { POST: route.POST, registro: () => ({ sql, graph, sessoesConsultadas }) };
}

function pedido(o: { cookie?: string | null; csrf?: string | null; origem?: string | null; query?: string; corpo?: string } = {}) {
  const { NextRequest } = requireModule('next/server');
  const headers = new Headers();
  if (o.cookie !== null) headers.set('cookie', `${COOKIE}=${o.cookie ?? TOKEN_SESSAO}`);
  if (o.csrf !== null) headers.set('x-csrf-token', o.csrf ?? CSRF);
  if (o.origem !== null) headers.set('origin', o.origem ?? ORIGEM);
  return new NextRequest(URL_ROTA + (o.query ?? ''), { method: 'POST', headers, body: o.corpo });
}

test('rota: Gestão de revisão com sessão, origem e CSRF válidos lê os ativos só com GET; token nunca na resposta', async () => {
  const r = rota();
  const resposta = await r.POST(pedido());
  assert.equal(resposta.status, 200);
  const texto = await resposta.text(), corpo = JSON.parse(texto);
  assert.equal(corpo.ok, true);
  assert.equal(corpo.data.requisitoKidmaisIsOnBizApp, 'nao_atendido');
  assert.equal(texto.includes(TOKEN_META), false);
  assert.deepEqual(r.registro().graph.map((g) => g.method), ['GET', 'GET']);
  assert.ok(r.registro().sql.every((q) => /UPDATE sessoes_administrativas SET ultima_atividade_em/.test(q)), 'única escrita: atividade da sessão');
});

test('rota: trava fechada responde 404 antes de consultar sessão ou a Meta', async () => {
  for (const env of [{ ...envOk, RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg' }, { ...envOk, META_DEMO_ATIVOS_TESTE: undefined }, {}]) {
    const r = rota({ env });
    assert.equal((await r.POST(pedido())).status, 404);
    assert.deepEqual(r.registro(), { sql: [], graph: [], sessoesConsultadas: 0 });
  }
});

test('rota: sem sessão → 401; CSRF ausente ou inválido → 403; origem diferente → 403; nada chega à Meta', async () => {
  const casos: [string, Parameters<typeof pedido>[0], number, RegExp][] = [
    ['sem cookie de sessão', { cookie: null }, 401, /Autenticação administrativa necessária/],
    ['sessão desconhecida', { cookie: 'X'.repeat(43) }, 401, /Autenticação administrativa necessária/],
    ['CSRF ausente', { csrf: null }, 403, /Verificação CSRF recusada/],
    ['CSRF inválido', { csrf: 'outro-csrf' }, 403, /Verificação CSRF recusada/],
    ['origem diferente', { origem: 'https://atacante.example' }, 403, /Origem da requisição recusada/],
    ['sem origem', { origem: null }, 403, /Origem da requisição recusada/],
  ];
  for (const [nome, o, status, motivo] of casos) {
    const r = rota();
    const resposta = await r.POST(pedido(o));
    assert.equal(resposta.status, status, nome);
    assert.match((await resposta.json()).erro, motivo, nome);
    assert.equal(r.registro().graph.length, 0, `${nome}: nenhuma chamada à Meta`);
  }
});

test('rota: Gestão de outra empresa, outro usuário da mesma empresa ou papel sem Gestão → 404 sem chamar a Meta', async () => {
  const casos: [string, Cenario][] = [
    ['outra empresa', { tenant: { empresaComprovada: randomUUID() } }],
    ['outro usuário da mesma empresa', { usuarioSessao: randomUUID() }],
    ['sem Gestão', { tenant: { papelAtual: 'ADMINISTRATIVO' } }],
  ];
  for (const [nome, c] of casos) {
    const r = rota(c);
    assert.equal((await r.POST(pedido())).status, 404, nome);
    assert.equal(r.registro().graph.length, 0, nome);
  }
});

test('rota: query ou corpo (ids vindos do navegador) → 400 sem chamar a Meta; sem acesso comercial → 402', async () => {
  for (const o of [{ query: `?wabaId=${demo.ATIVOS_TESTE.wabaId}` }, { corpo: JSON.stringify({ wabaId: '999', businessId: '1' }) }, { corpo: '{}' }]) {
    const r = rota();
    assert.equal((await r.POST(pedido(o))).status, 400);
    assert.equal(r.registro().graph.length, 0);
  }
  const r = rota({ paywall402: true });
  assert.equal((await r.POST(pedido())).status, 402);
  assert.equal(r.registro().graph.length, 0);
});
