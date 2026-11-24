import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';

/**
 * 23/11/2026 (pedido de Felipe): Contratantes abre em "Em uso" — todas menos as desativadas — e informa quantas
 * desativadas (com a mesma busca) ficaram de fora. O padrão da API continua "Todas" para os outros chamadores.
 * Astra r1 (P2): página, total e contagens saem de uma única consulta (um snapshot).
 */
type Lista = { itens: unknown[]; total: number; desativadasOcultas: number };
const sessao = { id: 's', usuario_id: '00000000-0000-4000-8000-000000000001', papel: 'ADMINISTRATIVO' };

function servico() {
    const banco = executorFalso([
        [/FROM plataforma_desenvolvedores/, () => [{ id: 'd' }]],
        // a consulta da lista devolve as contagens em toda linha; sem linha na página, uma linha só com id nulo.
        [/WITH base AS MATERIALIZED/, () => [{ total: 7, desativadas: 3, internas: 0, id: null }]],
    ]);
    const deps = { withTransaction: async (w: (t: typeof banco) => Promise<unknown>) => w(banco), registrarAuditoria: async () => undefined };
    const mod = carregarModulo('lib/desenvolvedor/empresas.ts', { 'db/postgres': { db: () => banco, withTransaction: deps.withTransaction } }) as
        { listarEmpresas: (s: unknown, r: unknown, d: unknown) => Promise<Lista> };
    return { listar: (raw: unknown) => mod.listarEmpresas(sessao, raw, deps), banco };
}
const consultas = (banco: ReturnType<typeof servico>['banco']) => banco.executados.filter((e) => /FROM empresas e/.test(e.sql));

test('Em uso: filtra fora as desativadas no SQL e conta as ocultas com a mesma busca, na mesma consulta', async () => {
    const { listar, banco } = servico();
    const r = await listar({ situacao: 'EM_USO', busca: 'buffet' });
    assert.equal(r.total, 7);
    assert.equal(r.desativadasOcultas, 3);
    assert.deepEqual(r.itens, [], 'linha só de contagens não vira item');
    const [lista, ...outras] = consultas(banco);
    assert.equal(outras.length, 0, 'uma consulta só para página e contagens');
    assert.match(lista.sql, /WHEN 'EM_USO' THEN e\.status <> 'DESATIVADA'/);
    assert.match(lista.sql, /count\(\*\) FILTER \(WHERE status = 'DESATIVADA'\)/);
    assert.match(lista.sql, /count\(\*\) FILTER \(WHERE no_filtro\)/);
    assert.deepEqual(lista.params, ['%buffet%', 'EM_USO', '', 0]);
});

test('outros filtros e o padrão da API (Todas) não informam ocultas', async () => {
    for (const raw of [{}, { situacao: 'TODAS' }, { situacao: 'DESATIVADA' }, { situacao: 'ATIVA' }]) {
        const { listar, banco } = servico();
        const r = await listar(raw);
        assert.equal(r.desativadasOcultas, 0);
        assert.equal(consultas(banco).length, 1, JSON.stringify(raw));
        if (!('situacao' in raw)) assert.equal(consultas(banco)[0].params[1], 'TODAS');
    }
});

test('página 2 desloca 25', async () => {
    const { listar, banco } = servico();
    await listar({ situacao: 'EM_USO', pagina: 2 });
    assert.equal(consultas(banco)[0].params[3], 25);
});

test('situação desconhecida continua recusada', async () => {
    const { listar } = servico();
    await assert.rejects(listar({ situacao: 'OCULTAS' }));
});
