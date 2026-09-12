import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ATALHOS_CONVIDADOS, atalhosConvidados } from './convidados.ts';
for (const valor of [110, 130, 140])
    test(`atalho ${valor} disponível`, () => assert(atalhosConvidados(50, 150).includes(valor as 110)));
test('opções anteriores preservadas e ordenadas', () => {
    for (const valor of [20, 30, 40, 50, 60, 80, 100, 120, 150])
        assert(ATALHOS_CONVIDADOS.includes(valor as 50));
    assert.deepEqual([...ATALHOS_CONVIDADOS], [...ATALHOS_CONVIDADOS].sort((a, b) => a - b));
});
test('atalhos respeitam limites específicos do pacote', () => assert.deepEqual(atalhosConvidados(20, 50), [20, 30, 40, 50]));
