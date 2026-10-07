import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';

const { perfilDoTenant } = carregarModulo('lib/perfil/tenant.ts', {}) as { perfilDoTenant: (tx: unknown, id: string) => Promise<string> };
test('perfil legado: associação única, status ativo e empresa do servidor; ausência/ambiguidade recusam', async () => {
    for (const linhas of [[], [{ id: 'p1' }, { id: 'p2' }]]) {
        const tx = executorFalso([[/SELECT p.id/, () => linhas]]);
        await assert.rejects(perfilDoTenant(tx, 'empresa-provadas'), /ainda não está disponível/);
    }
    const tx = executorFalso([[/SELECT p.id/, () => [{ id: 'p1' }]]]);
    assert.equal(await perfilDoTenant(tx, 'empresa-provadas'), 'p1');
    assert.match(tx.executados[0].sql, /e.candidatos=1 AND e.status='ATIVA'/);
    assert.match(tx.executados[0].sql, /WHERE e.id=\$1::uuid/);
    assert.deepEqual(tx.executados[0].params, ['empresa-provadas']);
});
