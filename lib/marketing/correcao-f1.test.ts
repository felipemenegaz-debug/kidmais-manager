import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * F1 da revisão de f917f98 (15/10/2026), parte sem banco: a FORMA do protocolo no formulário — trava da linha do
 * cliente antes de qualquer leitura decisória (descadastro, números) e antes do INSERT. A prova de que a trava
 * coordena de fato com a edição do cadastro (MVCC, gatilho, duas conexões) é a suíte correcao-f1.postgres.test.ts;
 * este teste não substitui aquela.
 */
type Pref = { registrarAutorizacaoDoFormulario(tx: unknown, e: string, c: string, k: string, tel: string): Promise<string> };
const EMPRESA = '11111111-1111-4111-8111-111111111111';
const CLIENTE = '22222222-2222-4222-8222-222222222222';
const CONTATO = '33333333-3333-4333-8333-333333333333';

function gravador(cadastro: { whatsapp: string | null; telefone: string | null }) {
  const sqls: string[] = [];
  const tx = { async query(sql: string) {
    sqls.push(sql.replace(/\s+/g, ' ').trim());
    if (sql.includes("to_regclass('public.marketing_contato_autorizacoes')")) return { rows: [{ ok: true }], rowCount: 1 };
    if (sql.includes('FROM marketing_contato_preferencias')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM clientes')) return { rows: [cadastro], rowCount: 1 };
    if (sql.includes('INSERT INTO marketing_contato_autorizacoes')) return { rows: [{ id: 'a1' }], rowCount: 1 };
    throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
  } };
  return { tx, sqls };
}

test('F1: o formulário trava a linha do cliente (FOR NO KEY UPDATE) antes de ler descadastro e números e antes do INSERT', async () => {
  const pref = carregarModulo('lib/marketing/automacoes/preferencias.ts', {}) as unknown as Pref;
  for (const [cadastro, esperado] of [[{ whatsapp: '5511944000001', telefone: null }, 'CONFIRMADA'], [{ whatsapp: '5511944000002', telefone: null }, 'PENDENTE']] as const) {
    const { tx, sqls } = gravador(cadastro);
    assert.equal(await pref.registrarAutorizacaoDoFormulario(tx, EMPRESA, CLIENTE, CONTATO, '11944000001'), esperado);
    const trava = sqls.findIndex((s) => /FROM clientes .*FOR NO KEY UPDATE$/.test(s));
    const descadastro = sqls.findIndex((s) => s.includes('FROM marketing_contato_preferencias'));
    const insert = sqls.findIndex((s) => s.includes('INSERT INTO marketing_contato_autorizacoes'));
    assert.ok(trava >= 0, 'leitura do cadastro com trava de linha');
    assert.ok(trava < descadastro && descadastro < insert, `ordem trava → descadastro → INSERT (${sqls.map((s) => s.slice(0, 40)).join(' | ')})`);
    assert.equal(sqls.filter((s) => s.includes('FROM clientes')).length, 1, 'uma única leitura do cadastro, a travada');
  }
});
