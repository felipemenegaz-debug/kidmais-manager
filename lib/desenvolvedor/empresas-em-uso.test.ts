import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';

/**
 * 23/11/2026 (pedido de Felipe): Contratantes abre em "Em uso" — todas menos as desativadas — e informa quantas
 * desativadas (com a mesma busca) ficaram de fora. O padrão da API continua "Todas" para os outros chamadores.
 */
type Lista = { itens: unknown[]; total: number; desativadasOcultas: number };
const sessao = { id: 's', usuario_id: '00000000-0000-4000-8000-000000000001', papel: 'ADMINISTRATIVO' };

function servico() {
    const banco = executorFalso([
        [/FROM plataforma_desenvolvedores/, () => [{ id: 'd' }]],
        // total da lista: 7 com o filtro pedido; 3 quando a mesma condição roda com $2 = DESATIVADA.
        [/SELECT count\(\*\)::int AS n FROM empresas e/, (p) => [{ n: p[1] === 'DESATIVADA' ? 3 : 7 }]],
    ]);
    const deps = { withTransaction: async (w: (t: typeof banco) => Promise<unknown>) => w(banco), registrarAuditoria: async () => undefined };
    const mod = carregarModulo('lib/desenvolvedor/empresas.ts', { 'db/postgres': { db: () => banco, withTransaction: deps.withTransaction } }) as
        { listarEmpresas: (s: unknown, r: unknown, d: unknown) => Promise<Lista> };
    return { listar: (raw: unknown) => mod.listarEmpresas(sessao, raw, deps), banco };
}
const contagens = (banco: ReturnType<typeof servico>['banco']) => banco.executados.filter((e) => /SELECT count\(\*\)::int AS n FROM empresas e/.test(e.sql));

test('Em uso: filtra fora as desativadas no SQL e conta as ocultas com a mesma busca', async () => {
    const { listar, banco } = servico();
    const r = await listar({ situacao: 'EM_USO', busca: 'buffet' });
    assert.equal(r.total, 7);
    assert.equal(r.desativadasOcultas, 3);
    const [total, ocultas] = contagens(banco);
    assert.match(total.sql, /WHEN 'EM_USO' THEN e\.status <> 'DESATIVADA'/);
    assert.equal(total.params[1], 'EM_USO');
    assert.deepEqual(ocultas.params, [total.params[0], 'DESATIVADA', total.params[2]], 'mesma busca, só a situação muda');
    assert.equal(ocultas.params[0], '%buffet%');
});

test('outros filtros e o padrão da API (Todas) não contam ocultas', async () => {
    for (const raw of [{}, { situacao: 'TODAS' }, { situacao: 'DESATIVADA' }, { situacao: 'ATIVA' }]) {
        const { listar, banco } = servico();
        const r = await listar(raw);
        assert.equal(r.desativadasOcultas, 0);
        assert.equal(contagens(banco).length, 1, JSON.stringify(raw));
        if (!('situacao' in raw)) assert.equal(contagens(banco)[0].params[1], 'TODAS');
    }
});

test('situação desconhecida continua recusada', async () => {
    const { listar } = servico();
    await assert.rejects(listar({ situacao: 'OCULTAS' }));
});
