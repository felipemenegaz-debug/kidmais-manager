import assert from 'node:assert/strict';
import test from 'node:test';
import { conexaoDeClientePg, PrazoDaTransacaoVencido, transacaoComPrazo, type ConexaoDescartavel } from './transacao-com-prazo.ts';

/**
 * D1 — prazo do lado da aplicação da transação independente (sem banco: conexão falsa que pode "nunca responder").
 * Cobre BEGIN, consulta, COMMIT, ROLLBACK e a própria obtenção da conexão; o descarte; e que nada é enviado depois do prazo.
 */
const PRAZO = 80;
const nunca = () => new Promise<never>(() => undefined);

function conexaoFalsa(semResposta: (sql: string) => boolean = () => false) {
    const enviados: string[] = [];
    const estado = { liberada: 0, descartada: 0, motivo: null as Error | null };
    const conexao: ConexaoDescartavel = {
        query: (async (sql: string) => {
            enviados.push(sql);
            if (semResposta(sql)) return nunca();
            if (sql === 'FALHAR') throw new Error('erro conhecido');
            return { rows: [{ ok: true }], rowCount: 1 };
        }) as ConexaoDescartavel['query'],
        liberar: () => { estado.liberada += 1; },
        descartar: (m) => { estado.descartada += 1; estado.motivo = m; },
    };
    return { conexao, enviados, estado };
}
async function medir<T>(p: Promise<T>) {
    const t0 = Date.now();
    try { await p; return { ms: Date.now() - t0, erro: null as unknown }; }
    catch (erro) { return { ms: Date.now() - t0, erro }; }
}

test('D1: sem atraso → BEGIN, trabalho, COMMIT; conexão LIBERADA (volta ao pool), nunca descartada', async () => {
    const f = conexaoFalsa();
    const r = await transacaoComPrazo(async () => f.conexao, PRAZO)(async (tx) => (await tx.query('SELECT 1')).rows.length);
    assert.equal(r, 1);
    assert.deepEqual([f.enviados, f.estado.liberada, f.estado.descartada], [['BEGIN', 'SELECT 1', 'COMMIT'], 1, 0]);
});

for (const [etapa, semResposta, esperados] of [
    ['BEGIN', (s: string) => s === 'BEGIN', ['BEGIN']],
    ['INSERT', (s: string) => s.startsWith('INSERT'), ['BEGIN', 'INSERT INTO x']],
    ['COMMIT', (s: string) => s === 'COMMIT', ['BEGIN', 'INSERT INTO x', 'SELECT depois', 'COMMIT']],
] as const) {
    test(`D1: ${etapa} sem resposta → falha no prazo (finito), conexão DESCARTADA, nada mais é enviado`, async () => {
        const f = conexaoFalsa(semResposta);
        let depois = false;
        const m = await medir(transacaoComPrazo(async () => f.conexao, PRAZO)(async (tx) => {
            await tx.query('INSERT INTO x');
            depois = true;
            await tx.query('SELECT depois');
        }));
        assert.ok(m.erro instanceof PrazoDaTransacaoVencido, String(m.erro));
        assert.equal((m.erro as PrazoDaTransacaoVencido).etapa, etapa);
        assert.ok(m.ms >= PRAZO - 5 && m.ms < PRAZO + 500, `prazo finito: ${m.ms} ms`);
        assert.deepEqual([f.enviados, f.estado.descartada, f.estado.liberada], [esperados, 1, 0]);
        assert.ok(f.estado.motivo instanceof PrazoDaTransacaoVencido);
        if (etapa !== 'COMMIT') assert.equal(depois, false, 'o trabalho não continua depois do prazo');
        // Depois do prazo, a conexão abandonada não recebe mais nada (nem ROLLBACK).
        await new Promise((ok) => setTimeout(ok, PRAZO));
        assert.deepEqual(f.enviados, esperados);
    });
}

test('D1: COMMIT sem resposta é resultado DESCONHECIDO para quem chama (falha), mesmo que o servidor tenha aplicado', async () => {
    const f = conexaoFalsa((s) => s === 'COMMIT');
    await assert.rejects(transacaoComPrazo(async () => f.conexao, PRAZO)(async () => 'gravado?'), (e: unknown) => e instanceof PrazoDaTransacaoVencido && /resultado desconhecido/.test((e as Error).message));
});

test('D1: erro conhecido no meio → ROLLBACK e conexão liberada; ROLLBACK sem resposta → descartada no prazo; o erro original é o que sobe', async () => {
    const ok = conexaoFalsa();
    await assert.rejects(transacaoComPrazo(async () => ok.conexao, PRAZO)(async (tx) => { await tx.query('FALHAR'); }), /erro conhecido/);
    assert.deepEqual([ok.enviados, ok.estado.liberada, ok.estado.descartada], [['BEGIN', 'FALHAR', 'ROLLBACK'], 1, 0]);
    const presa = conexaoFalsa((s) => s === 'ROLLBACK');
    const m = await medir(transacaoComPrazo(async () => presa.conexao, PRAZO)(async (tx) => { await tx.query('FALHAR'); }));
    assert.match(String(m.erro), /erro conhecido/);
    assert.ok(m.ms < PRAZO + 500);
    assert.deepEqual([presa.estado.liberada, presa.estado.descartada], [0, 1]);
});

test('D1: obter a conexão sem resposta → falha no prazo; a conexão que chega depois é descartada (não fica presa)', async () => {
    const f = conexaoFalsa();
    let entregar: (c: ConexaoDescartavel) => void = () => undefined;
    const m = await medir(transacaoComPrazo(() => new Promise<ConexaoDescartavel>((ok) => { entregar = ok; }), PRAZO)(async () => 'nunca'));
    assert.ok(m.erro instanceof PrazoDaTransacaoVencido);
    assert.equal((m.erro as PrazoDaTransacaoVencido).etapa, 'OBTER_CONEXAO');
    entregar(f.conexao);
    await new Promise((ok) => setTimeout(ok, 10));
    assert.deepEqual([f.estado.descartada, f.estado.liberada, f.enviados], [1, 0, []]);
});

test('D1: adaptador do pg — descartar destrói o soquete e entrega o descarte (pool: release(erro), nunca release())', () => {
    const chamadas: string[] = [];
    const cliente = {
        query: async () => ({ rows: [], rowCount: 0 }),
        connection: { stream: { destroy: () => { chamadas.push('soquete destruído'); } } },
    };
    const c = conexaoDeClientePg(cliente, { liberar: () => chamadas.push('liberar'), descartar: (m) => chamadas.push(`descartar: ${m.message}`) });
    c.descartar(new Error('prazo'));
    assert.deepEqual(chamadas, ['soquete destruído', 'descartar: prazo']);
});
