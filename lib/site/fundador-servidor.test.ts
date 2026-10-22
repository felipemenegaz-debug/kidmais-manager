import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/** O site nunca espera o banco além do limite: demora ou falha viram texto neutro (null). */
type Tx = { query: (sql: string) => Promise<{ rows: object[] }> };
const carregar = (withTransaction: (t: (tx: Tx) => Promise<unknown>) => Promise<unknown>) =>
    carregarModulo('lib/site/fundador-servidor.ts', { 'lib/db/postgres': { withTransaction } }, new Map()) as {
        resumoCampanhaSite: (limiteMs?: number) => Promise<unknown> };

test('banco lento: devolve null no limite, sem esperar a consulta', async () => {
    const { resumoCampanhaSite } = carregar(() => new Promise(() => {}));
    const inicio = Date.now();
    assert.equal(await resumoCampanhaSite(50), null);
    assert.ok(Date.now() - inicio < 1000);
});

test('falha de leitura vira null; leitura normal limita a consulta e devolve o resumo', async () => {
    assert.equal(await carregar(async () => { throw new Error('sem banco'); }).resumoCampanhaSite(50), null);
    const sqls: string[] = [];
    const tx: Tx = { query: async (sql) => { sqls.push(sql); return { rows: sql.includes('AS instalado090') ? [{ instalado090: false }] : [] }; } };
    assert.deepEqual(await carregar((t) => t(tx)).resumoCampanhaSite(1000), { fase: 'LEGADO' });
    assert.match(sqls[0]!, /SET LOCAL statement_timeout = '2s'/);
});
