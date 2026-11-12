import test from 'node:test';
import assert from 'node:assert/strict';
import * as utils from './horario.utils.ts';
import * as conjuntos from '../../agenda/saloes-conjuntos.ts';
import { EMPRESA, transpilar } from './duracao-pacote-livre.test-apoio.ts';

/**
 * Revisão da integração d6ddbc6 (P2-I1): salões permitidos pelo pacote sem a 093. Executor que imita o PostgreSQL:
 * citar `pacote_saloes` sem a tabela dá 42P01 e aborta a transação (25P02 em toda consulta seguinte). Sem banco.
 */
function executor(com093: boolean, linhas: Array<{ salao_id: string | null }> = [], falhaReal = false) {
    const sqls: string[] = [];
    let abortada = false;
    const tx = {
        query: async (sql: string) => {
            sqls.push(sql);
            if (abortada) throw Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
            if (/to_regclass\('public\.pacote_saloes'\) IS NOT NULL AS ok/.test(sql) && !/FROM pacotes/.test(sql)) return { rows: [{ ok: com093 }] };
            if (/pacote_saloes/.test(sql)) {
                if (!com093) { abortada = true; throw Object.assign(new Error('relation "pacote_saloes" does not exist'), { code: '42P01' }); }
                if (falhaReal) { abortada = true; throw Object.assign(new Error('lock timeout'), { code: '55P03' }); }
                return { rows: linhas };
            }
            return { rows: [{ ok: true }] };
        },
    };
    return { tx, sqls, abortada: () => abortada };
}
const erros = { AvailabilityServiceError: class extends Error {} };
const m = transpilar('lib/disponibilidade/services/availability.service.ts', {
    '../../db/postgres.ts': { db: () => { throw new Error('use o executor do teste'); } },
    '../escopo.ts': { escopoDoFechamento: async () => ({ empresaId: EMPRESA, estabelecimentoId: null }) },
    '../repositories/disponibilidade.repository.ts': {},
    './errors.ts': erros,
    './horario.utils.ts': utils,
    '../../agenda/saloes-conjuntos.ts': conjuntos,
}) as unknown as { saloesDoPacoteDaEmpresa: (tx: unknown, e: string | null, c?: string) => Promise<string[] | null> };

test('sem a 093: null, sem citar pacote_saloes; a transação continua utilizável (antes: 42P01 + 25P02)', async () => {
    const e = executor(false);
    assert.equal(await m.saloesDoPacoteDaEmpresa(e.tx, EMPRESA, 'P_1'), null);
    assert.equal(e.abortada(), false);
    assert.equal(e.sqls.length, 1, 'só a consulta de existência');
    assert.ok(!e.sqls.some((s) => /FROM pacotes/.test(s)));
    // Próxima consulta da mesma transação funciona.
    assert.deepEqual((await e.tx.query('SELECT 1 AS ok')).rows, [{ ok: true }]);
});

test('com a 093: lista dos salões; a consulta dos salões não depende do to_regclass no WHERE', async () => {
    const e = executor(true, [{ salao_id: 's1' }, { salao_id: 's2' }]);
    assert.deepEqual(await m.saloesDoPacoteDaEmpresa(e.tx, EMPRESA, 'P_1'), ['s1', 's2']);
    assert.equal(e.sqls.length, 2);
    assert.doesNotMatch(e.sqls[1], /to_regclass/);
    // Pacote sem restrição (LEFT JOIN sem linha): null = todos os salões.
    assert.equal(await m.saloesDoPacoteDaEmpresa(executor(true, [{ salao_id: null }]).tx, EMPRESA, 'P_1'), null);
});

test('com a 093 e erro real do banco: o erro propaga (não vira "sem restrição" com a transação abortada)', async () => {
    const e = executor(true, [], true);
    await assert.rejects(m.saloesDoPacoteDaEmpresa(e.tx, EMPRESA, 'P_1'), (x: { code?: string }) => x.code === '55P03');
});

test('sem empresa ou sem pacote: null sem consultar', async () => {
    const e = executor(true);
    assert.equal(await m.saloesDoPacoteDaEmpresa(e.tx, null, 'P_1'), null);
    assert.equal(await m.saloesDoPacoteDaEmpresa(e.tx, EMPRESA, undefined), null);
    assert.deepEqual(e.sqls, []);
});
