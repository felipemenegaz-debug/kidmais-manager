import test from 'node:test';
import assert from 'node:assert/strict';
import { chaveFranquia, devidoDoCiclo, marcoDeUso, TABELA_FRANQUIAS, valorDoPlano } from './franquias-regra.ts';

/** Exemplos fixos do plano rev. 4.1 (§4.2), novembro/2026 = 30 dias; a fração conta o dia da confirmação. */
const NOV = { recurso: 'CONVITES' as const, piso: 0, diasNoMes: 30 };

test('tabela decidida em 03/11 (D-FR-1, D-FR-4, D-PL-2) e versão', () => {
    assert.equal(TABELA_FRANQUIAS.versao, '2026-11-03');
    assert.deepEqual({ ...TABELA_FRANQUIAS.CONVITES }, { essencial: 10, profissional: 15, premium: 30 });
    assert.deepEqual({ ...TABELA_FRANQUIAS.WHATSAPP }, { essencial: 0, profissional: 0, premium: 300 });
    assert.deepEqual({ ...TABELA_FRANQUIAS.COPILOTO }, { essencial: 100, profissional: 300, premium: 1000 });
    assert.ok(Object.isFrozen(TABELA_FRANQUIAS) && Object.isFrozen(TABELA_FRANQUIAS.CONVITES));
});

test('piso legado: vale o maior (D-FR-7); sem plano vale o piso', () => {
    assert.equal(valorDoPlano('CONVITES', 'essencial', 25), 25);
    assert.equal(valorDoPlano('CONVITES', 'premium', 25), 30);
    assert.equal(valorDoPlano('CONVITES', null, 7), 7);
    assert.throws(() => valorDoPlano('CONVITES', 'premium', -1), /piso/);
});

test('exemplo 1: recorrente (Premium desde outubro) = 30, qualquer que seja o dia do worker', () => {
    assert.equal(devidoDoCiclo({ ...NOV, planoInicial: 'premium', mudancas: [] }).devido, 30);
});

test('exemplos 2 e 3: ativação em 16/11 = 15; em 15/11 = 16', () => {
    assert.equal(devidoDoCiclo({ ...NOV, planoInicial: null, mudancas: [{ dia: 16, plano: 'premium', contratacaoId: 'a' }] }).devido, 15);
    assert.equal(devidoDoCiclo({ ...NOV, planoInicial: null, mudancas: [{ dia: 15, plano: 'premium', contratacaoId: 'a' }] }).devido, 16);
});

test('exemplos 4 e 5: Essencial desde outubro e Premium em 16/11 = 10 + ceil(20 × 15/30) = 20', () => {
    const r = devidoDoCiclo({ ...NOV, planoInicial: 'essencial', mudancas: [{ dia: 16, plano: 'premium', contratacaoId: 'p' }] });
    assert.equal(r.devido, 20);
    assert.equal(r.maximo, 30);
    assert.deepEqual(r.segmentos.map((s) => s.parcela), [10, 10]);
});

test('exemplo 6: ida e volta (Premium → Profissional 05/11 → Premium 20/11) = 30', () => {
    assert.equal(devidoDoCiclo({ ...NOV, planoInicial: 'premium', mudancas: [
        { dia: 5, plano: 'profissional', contratacaoId: 'b' }, { dia: 20, plano: 'premium', contratacaoId: 'c' }] }).devido, 30);
});

test('exemplo 7 (adoção): devido 30 com o Premium vigente; o complemento é 30 − 10 adotados', () => {
    assert.equal(devidoDoCiclo({ ...NOV, planoInicial: 'premium', mudancas: [] }).devido - 10, 20);
});

test('dois upgrades somam só as diferenças; devido nunca passa do máximo', () => {
    const r = devidoDoCiclo({ ...NOV, planoInicial: 'essencial', mudancas: [
        { dia: 1, plano: 'profissional', contratacaoId: 'x' }, { dia: 30, plano: 'premium', contratacaoId: 'y' }] });
    assert.equal(r.devido, 10 + 5 + 1); // dia 1: fração 30/30; dia 30: ceil(15 × 1/30) = 1
    assert.ok(r.devido <= r.maximo);
    for (let dia = 1; dia <= 30; dia++)
        for (const ini of [null, 'essencial', 'profissional'] as const)
            assert.ok(devidoDoCiclo({ ...NOV, planoInicial: ini, mudancas: [{ dia, plano: 'premium', contratacaoId: 'z' }] }).devido <= 30);
});

test('piso legado maior que a tabela: upgrade não soma nada', () => {
    assert.equal(devidoDoCiclo({ recurso: 'CONVITES', piso: 40, diasNoMes: 30, planoInicial: 'essencial', mudancas: [{ dia: 10, plano: 'premium', contratacaoId: 'q' }] }).devido, 40);
});

test('meses de 28 e 31 dias; entradas inválidas recusadas', () => {
    assert.equal(devidoDoCiclo({ recurso: 'CONVITES', piso: 0, diasNoMes: 28, planoInicial: null, mudancas: [{ dia: 28, plano: 'premium', contratacaoId: 'f' }] }).devido, 2);
    assert.equal(devidoDoCiclo({ recurso: 'CONVITES', piso: 0, diasNoMes: 31, planoInicial: null, mudancas: [{ dia: 1, plano: 'premium', contratacaoId: 'f' }] }).devido, 30);
    assert.throws(() => devidoDoCiclo({ ...NOV, planoInicial: null, mudancas: [{ dia: 31, plano: 'premium', contratacaoId: 'f' }] }), /dia/);
    assert.throws(() => devidoDoCiclo({ ...NOV, planoInicial: null, mudancas: [{ dia: 10, plano: 'premium', contratacaoId: 'a' }, { dia: 9, plano: 'essencial', contratacaoId: 'b' }] }), /ordem/);
    assert.throws(() => devidoDoCiclo({ ...NOV, diasNoMes: 27, planoInicial: null, mudancas: [] }), /dias/);
});

test('chaves: mensal sem sufixo, complementos :R<n>', () => {
    assert.equal(chaveFranquia('2026-11-01', 0, false), 'FRANQUIA:2026-11');
    assert.equal(chaveFranquia('2026-11-01', 1, true), 'FRANQUIA:2026-11:R2');
    assert.throws(() => chaveFranquia('2026-11-15', 0, false), /ciclo/);
});

test('marcos de uso: 80% e 100%', () => {
    assert.equal(marcoDeUso(7, 10), null);
    assert.equal(marcoDeUso(8, 10), 'FRANQUIA_80');
    assert.equal(marcoDeUso(10, 10), 'FRANQUIA_100');
    assert.equal(marcoDeUso(24, 30), 'FRANQUIA_80');
    assert.equal(marcoDeUso(23, 30), null);
    assert.equal(marcoDeUso(5, 0), null);
});
