import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import { z } from 'zod';
import { IntegracaoImportadoError } from './servico.ts';

/**
 * Rota da integração carregada de verdade (dependências de sessão e transação simuladas): cada recusa de domínio e
 * do banco vira o status e o código do contrato da API, sem detalhe interno; erro desconhecido não vira 409.
 */
const ROTA = 'app/api/admin/contratos/importados/[importacaoId]/integracao/route.ts';
const IMP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function carregar(falha: () => unknown, capturado: { ctx?: Record<string, unknown> } = {}) {
  const exports: Record<string, unknown> = {};
  const js = ts.transpileModule(readFileSync(ROTA, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const NextResponse = { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) };
  const deps: Record<string, unknown> = {
    'node:crypto': crypto,
    'next/server': { NextResponse, NextRequest: class {} },
    zod: { z },
    '@/lib/contratos/integracao-importados/composicao': { coreNativo: {} },
    '@/lib/contratos/integracao-importados/servico': {
      IntegracaoImportadoError,
      opcoesIntegracao: async () => ({}), simularIntegracao: async () => ({}), simularFinanceiro: async () => ({}),
      confirmarIntegracao: async (_tx: unknown, _t: unknown, ctx: Record<string, unknown>) => { capturado.ctx = ctx; return falha(); },
      conferirFinanceiro: async () => falha(),
    },
    '@/lib/financeiro/calculos': { hojeBrasilia: () => '2026-10-03' },
    '@/lib/http/admin-crm-api': {
      exigirApiAdminCrmDisponivel: async () => ({ usuario_id: 'u1', autenticado_em: '2026-10-03T12:00:00Z' }),
      tokenAdmin: () => 'token',
    },
    '@/lib/http/api-response': { apiErrorResponse: (e: unknown) => new Response(JSON.stringify({ ok: false, erro: 'Erro interno.', codigo: 'ERRO_INTERNO', bruto: String(e) }), { status: 500 }) },
    '@/lib/saas/provar-tenant': {
      withTenantTransaction: async (_s: unknown, _e: unknown, work: (tx: unknown, t: unknown) => Promise<unknown>) => work({}, { usuarioId: 'u1', empresaComprovada: 'e1', papelAtual: 'ADMINISTRATIVO' }),
    },
  };
  new Function('require', 'exports', js)((id: string) => { assert(id in deps, `Dependência não simulada: ${id}`); return deps[id]; }, exports);
  return exports as { POST: (r: unknown, c: unknown) => Promise<Response> };
}

const pedido = (corpo: unknown) => ({ json: async () => corpo, headers: new Headers({ 'user-agent': 'teste' }), nextUrl: new URL('http://kidmais.test/x') });
const contexto = { params: Promise.resolve({ importacaoId: IMP }) };
const confirmar = { acao: 'confirmar', decisoes: {}, resumoHash: 'a'.repeat(64), chave: '88888888-8888-4888-8888-888888888888' };
const doBanco = (code: string, message = '') => () => { throw Object.assign(new Error(message), { code }); };

async function responder(falha: () => unknown, corpo: unknown = confirmar) {
  const r = await carregar(falha).POST(pedido(corpo), contexto);
  return { status: r.status, corpo: await r.json() as { ok: boolean; codigo?: string; erro?: string } };
}

test('erros de domínio: status e código do serviço (idempotência, reautenticação, bloqueio)', async () => {
  for (const [codigo, status] of [['IDEMPOTENCIA_CONFLITANTE', 409], ['REAUTENTICACAO_NECESSARIA', 403], ['INTEGRACAO_BLOQUEADA', 422], ['IMPORTACAO_JA_INTEGRADA', 409]] as const) {
    const r = await responder(() => { throw new IntegracaoImportadoError(codigo, 'mensagem de domínio', status); });
    assert.deepEqual([r.status, r.corpo.codigo, r.corpo.erro], [status, codigo, 'mensagem de domínio']);
  }
});

test('erros do banco: códigos de domínio, sem detalhe interno e sem identificar ocupante', async () => {
  const casos: Array<[() => unknown, number, string]> = [
    [doBanco('23514', '062: unidade sem habilitação vigente; confirmar nova reserva exige unidade habilitada'), 409, 'UNIDADE_NAO_HABILITADA'],
    [doBanco('23514', '061: a versão conferida não é mais a vigente (ou há revisão aberta ou cancelamento)'), 409, 'VERSAO_NAO_VIGENTE'],
    [doBanco('23514', 'Horário indisponível: formalização não concluída'), 409, 'CONFLITO_AGENDA'],
    [doBanco('23514', '061: parcela vence depois da festa sem a exceção histórica confirmada'), 409, 'INTEGRACAO_RECUSADA'],
    [doBanco('P0001', 'regra qualquer'), 409, 'INTEGRACAO_RECUSADA'],
    [doBanco('23503', 'violates foreign key constraint "x"'), 409, 'REFERENCIA_INVALIDA'],
    [doBanco('23505', 'duplicate key value'), 409, 'IMPORTACAO_JA_INTEGRADA'],
    [doBanco('40P01', 'deadlock detected'), 409, 'CONCORRENCIA'],
    [doBanco('55P03', 'lock timeout'), 409, 'CONCORRENCIA'],
  ];
  for (const [falha, status, codigo] of casos) {
    const r = await responder(falha);
    assert.deepEqual([r.status, r.corpo.codigo], [status, codigo], codigo);
    assert.doesNotMatch(String(r.corpo.erro), /constraint|061:|062:|duplicate|deadlock/, 'mensagem sem detalhe interno');
  }
});

test('erro desconhecido não é mascarado como recusa de negócio; contexto leva a autenticação da sessão', async () => {
  const r = await responder(() => { throw new Error('falha inesperada'); });
  assert.equal(r.status, 500);
  const capturado: { ctx?: Record<string, unknown> } = {};
  await carregar(async () => ({ ok: true }), capturado).POST(pedido(confirmar), contexto);
  assert.equal(capturado.ctx?.autenticadoEm, '2026-10-03T12:00:00Z');
  assert.equal(capturado.ctx?.ip, null);
  const invalido = await carregar(() => ({})).POST(pedido(confirmar), { params: Promise.resolve({ importacaoId: 'nao-uuid' }) });
  assert.equal(invalido.status, 400);
});
