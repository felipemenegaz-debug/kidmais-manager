import assert from 'node:assert/strict';
import test from 'node:test';
import { planoComercialValido, planosComerciais, valorComercial, type PlanoComercialId, type CicloComercial } from './planos-comerciais.ts';
import { precoDoCiclo } from './configuracao.ts';

test('oferta: centavos exatos para três planos, anual 10× e Fundador 60%', () => {
    const esperados = { essencial: [19700,197000,11820,118200], profissional: [34700,347000,20820,208200], premium: [59700,597000,35820,358200] };
    for (const id of Object.keys(esperados) as PlanoComercialId[])
        assert.deepEqual([valorComercial(id,'mensal'),valorComercial(id,'anual'),valorComercial(id,'mensal',true),valorComercial(id,'anual',true)],esperados[id]);
    assert.deepEqual(Object.values(planosComerciais).map(p => p.limiteUsuarios), [3,10,null]);
});

test('oferta não aceita identificadores herdados, plano desconhecido ou condição inválida', () => {
    for (const id of ['UNICO','toString','__proto__','ESSENCIAL','',null,{},0]) {
        assert.equal(planoComercialValido(id),false);
        assert.throws(() => valorComercial(id as PlanoComercialId,'mensal'));
    }
    assert.throws(() => valorComercial('essencial','semanal' as CicloComercial));
    assert.throws(() => valorComercial('essencial','mensal','false' as unknown as boolean));
});

test('catálogo novo não habilita nem reprecifica cobrança legada', () => {
    assert.equal(precoDoCiclo('MENSAL', {}), null);
    assert.equal(precoDoCiclo('MENSAL', { ASSINATURA_PRECO_MENSAL_CENTAVOS: '12990' }), 12990);
});
