import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConexaoDescartavel } from '../db/transacao-com-prazo.ts';
import { lerMarcaComPrazo } from './marca-com-prazo.ts';
import { marcaDoContratoNaTransacao } from './marca-contrato.ts';

/** A marca é opcional: fila do pool parada, consulta sem resposta ou falha devolvem neutro dentro do orçamento. */
const NEUTRA = { kidmais: false, nome: null };

function conexao(responder: (sql: string) => Promise<unknown>) {
  const estado = { liberada: 0, descartada: 0, sqls: [] as string[] };
  const c: ConexaoDescartavel = {
    query: (async (sql: string) => { estado.sqls.push(sql); return responder(sql); }) as ConexaoDescartavel['query'],
    liberar: () => { estado.liberada += 1; },
    descartar: () => { estado.descartada += 1; },
  };
  return { c, estado };
}

test('fila do pool que nunca entrega a conexão: neutro no prazo', async () => {
  const inicio = Date.now();
  const marca = await lerMarcaComPrazo(() => new Promise(() => undefined), async () => ({ kidmais: false, nome: 'X' }), 60);
  assert.deepEqual(marca, NEUTRA);
  assert.ok(Date.now() - inicio < 1000, 'respondeu dentro do orçamento');
});

test('consulta sem resposta: neutro no prazo e conexão descartada', async () => {
  const { c, estado } = conexao(async (sql) => (/^(BEGIN|ROLLBACK)/.test(sql) ? { rows: [], rowCount: 0 } : new Promise(() => undefined)));
  const marca = await lerMarcaComPrazo(async (registrar) => { registrar(c); return c; }, async (tx) => {
    await tx.query('SELECT codigo FROM public.empresas WHERE id = $1', ['e']);
    return { kidmais: false, nome: 'X' };
  }, 60);
  assert.deepEqual(marca, NEUTRA);
  assert.equal(estado.descartada, 1);
  assert.equal(estado.liberada, 0);
});

test('falha da leitura: neutro', async () => {
  const { c } = conexao(async () => ({ rows: [], rowCount: 0 }));
  const marca = await lerMarcaComPrazo(async (registrar) => { registrar(c); return c; }, async () => { throw new Error('falha'); }, 500);
  assert.deepEqual(marca, NEUTRA);
});

test('leitura no prazo: devolve a marca e libera a conexão', async () => {
  const { c, estado } = conexao(async () => ({ rows: [], rowCount: 0 }));
  const marca = await lerMarcaComPrazo(async (registrar) => { registrar(c); return c; }, async () => ({ kidmais: false, nome: 'Buffet X' }), 500);
  assert.deepEqual(marca, { kidmais: false, nome: 'Buffet X' });
  assert.equal(estado.liberada, 1);
  assert.equal(estado.descartada, 0);
});

test('rota do Resumo: a marca opcional passa pelo orçamento curto com conexão descartável', async () => {
  const { transpilar } = await import('../disponibilidade/services/duracao-pacote-livre.test-apoio.ts');
  const conexaoDescartavelDoPool = async () => { throw new Error('sem conexão real'); };
  const chamadas: unknown[][] = [];
  const capturado: { marca?: (empresaId: string) => Promise<unknown> } = {};
  const rota = transpilar('app/api/admin/contratos/resumo-contratacao/route.ts', {
    'next/server': { NextResponse: { json: (corpo: unknown, init?: unknown) => ({ corpo, init }) } },
    zod: await import('zod'),
    '@/lib/db/postgres': { conexaoDescartavelDoPool },
    '@/lib/contratos/marca-com-prazo': { lerMarcaComPrazo: async (...args: unknown[]) => { chamadas.push(args); return { kidmais: false, nome: 'Buffet X' }; } },
    '@/lib/contratos/marca-contrato': { marcaDaEmpresa: async () => ({ kidmais: false, nome: 'Buffet X' }) },
    '@/lib/contratos/services/administrativo.service': { detalheAdministrativo: async () => null },
    '@/lib/contratos/services/resumo-tenant': {
      ResumoTenantError: class extends Error {},
      resumoContratacaoDoTenant: async (_s: unknown, _e: unknown, _c: unknown, deps: { marca: (id: string) => Promise<unknown> }) => { capturado.marca = deps.marca; return {}; },
    },
    '@/lib/http/api-response': { apiErrorResponse: (e: unknown) => { throw e; } },
    '@/lib/http/admin-crm-api': { exigirApiAdminCrmDisponivel: async () => ({}) },
    '@/lib/pagamentos/services/financeiro-consulta.service': { consultarPainelFinanceiro: async () => null },
    '@/lib/saas/provar-tenant': { withTenantTransaction: async () => null },
  }) as { GET(r: unknown): Promise<unknown> };
  await rota.GET({ nextUrl: { searchParams: new URLSearchParams({ contratoId: '11111111-1111-4111-8111-111111111111' }) } });
  assert.ok(capturado.marca, 'marca injetada no resumo');
  assert.deepEqual(await capturado.marca('emp'), { kidmais: false, nome: 'Buffet X' });
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0][0], conexaoDescartavelDoPool, 'conexão descartável do pool');
  assert.equal(chamadas[0].length, 2, 'prazo padrão de lerMarcaComPrazo');
});

test('erro de SQL na leitura da marca do contrato público: ROLLBACK, nunca COMMIT, e neutro', async () => {
  const { c, estado } = conexao(async (sql) => {
    if (/^(BEGIN|ROLLBACK|COMMIT)/.test(sql)) return { rows: [], rowCount: 0 };
    throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  });
  const marca = await lerMarcaComPrazo(async (registrar) => { registrar(c); return c; }, (tx) => marcaDoContratoNaTransacao(tx, '11111111-1111-4111-8111-111111111111'), 500);
  assert.deepEqual(marca, NEUTRA);
  assert.ok(estado.sqls.some((s) => /^ROLLBACK/.test(s)), 'desfez a transação');
  assert.ok(!estado.sqls.some((s) => /^COMMIT/.test(s)), 'sem COMMIT depois do erro');
});
