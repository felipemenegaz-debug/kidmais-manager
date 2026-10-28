import assert from 'node:assert/strict';
import test from 'node:test';
import { depsDoCaso, identidadeDoCaso, proporCasoReal, type ContextoRecuperacao } from './recuperacao-casos.ts';
import { chavesForaDaLista } from './recuperacao-provedor.ts';
import { LimpezaDoCasoFalhou } from './recuperacao-caso.ts';
import { evidenciaDoCaso } from './recuperacao-evidencia.ts';
import { itemDaBase } from './recuperacao-baseline.ts';
import { classificar } from './recuperacao-classes.ts';

/** B-14 (§3.1, §3.4): ligação do caso aos serviços. Sem banco: o SQL real fica na suíte .postgres. */
const EMP = '11111111-1111-4111-8111-111111111111';
const cliente = { obterAssinatura: async () => null, listarCobrancasDaAssinatura: async () => [], obterCobranca: async () => null,
    listarCobrancasPorReferencia: async () => [], removerAssinatura: async () => { throw new Error('escrita'); }, criarCobranca: async () => { throw new Error('escrita'); } };
const ctx = (extra: Partial<ContextoRecuperacao> = {}): ContextoRecuperacao => ({ tx: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
    execucao: '22222222-2222-4222-8222-222222222222', modo: 'RESTORE', cliente, presentes: [], ...extra });

test('identidade estável: sha de tipo + id interno, igual entre execuções e diferente por tipo', () => {
    assert.equal(identidadeDoCaso('PEDIDO', 'x'), identidadeDoCaso('PEDIDO', 'x'));
    assert.notEqual(identidadeDoCaso('PEDIDO', 'x'), identidadeDoCaso('EVENTO', 'x'));
    assert.match(identidadeDoCaso('EMPRESA', EMP), /^[0-9a-f]{64}$/);
    assert.equal(depsDoCaso(ctx(), { tipo: 'EMPRESA', id: EMP, empresaId: EMP }).caso, identidadeDoCaso('EMPRESA', EMP));
});

test('o serviço recebe só o provedor da lista fechada (sem métodos de escrita)', () => {
    const d = depsDoCaso(ctx(), { tipo: 'EMPRESA', id: EMP, empresaId: EMP });
    assert.deepEqual(chavesForaDaLista(d.provedor), []);
    assert.equal('removerAssinatura' in d.provedor, false);
    assert.throws(() => depsDoCaso(ctx({ cliente: { obterCobranca: async () => null } }), { tipo: 'EMPRESA', id: EMP, empresaId: EMP }), /leituras da assinatura/);
});

test('pedido sem contexto de créditos: o caso falha com código, desfaz o SAVEPOINT e não propõe nada', async () => {
    const sql: string[] = [];
    const r = await proporCasoReal(ctx({ tx: { query: async (q: string) => { sql.push(q); return { rows: [], rowCount: 0 }; } } as never }), { tipo: 'PEDIDO', id: 'p', empresaId: EMP });
    assert.equal(r.proposta, null);
    assert.equal(r.falha, 'ERRO_INTERNO: Error');
    assert.deepEqual(sql, ['SAVEPOINT b14_caso', 'ROLLBACK TO SAVEPOINT b14_caso', 'RELEASE SAVEPOINT b14_caso']);
});

test('D1: falha ao desfazer o SAVEPOINT não vira falha do caso — sobe tipada para o chamador desfazer a transação externa', async () => {
    const tx = { query: async (q: string) => { if (q.startsWith('ROLLBACK TO')) throw new Error('conexão perdida'); return { rows: [], rowCount: 0 }; } };
    await assert.rejects(proporCasoReal(ctx({ tx: tx as never }), { tipo: 'PEDIDO', id: 'p', empresaId: EMP }), (e: unknown) => e instanceof LimpezaDoCasoFalhou);
});

test('P3-6: a evidência exportável não leva a fotografia interna nem texto livre', async () => {
    const segredo = 'texto pessoal do arrependimento';
    const p = { caso: { tipo: 'EMPRESA' as const, id: EMP, empresaId: EMP }, identidade: 'i', falha: null, hash: 'h', semEfeito: true, resultado: null,
        proposta: { formato: 1, caso: 'i', precondicoes: { local: 'sha', remoto: [] }, efeitos: [] },
        antes: { assinatura_arrependimentos: [{ id: 'a', motivo: segredo }], auditoria: [{ id: 'x', dados_depois: { nome: segredo } }] } };
    const c = classificar({ modo: 'RESTORE', tipo: 'EMPRESA', id: EMP, empresaId: EMP, antes: p.antes, efeitos: [], leituras: [] });
    const ev = evidenciaDoCaso(p, c, itemDaBase(p, c));
    const texto = JSON.stringify(ev);
    assert.equal(texto.includes(segredo), false);
    assert.equal('antes' in ev, false);
    assert.deepEqual(Object.keys(ev).sort(), ['classe', 'falha', 'hash', 'hashComparavel', 'identidade', 'indicadores', 'limites', 'motivo', 'proposta', 'recusas', 'tipo']);
});
