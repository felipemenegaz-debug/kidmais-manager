import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfiguracaoComercialInvalida, duracaoTesteDias, precoDoCiclo, TESTE_DIAS_PADRAO } from './configuracao.ts';

test('teste grátis: 15 dias por padrão; configurável de 1 a 90; valor inválido é erro visível, nunca o padrão silencioso', () => {
    assert.equal(TESTE_DIAS_PADRAO, 15);
    assert.equal(duracaoTesteDias({}), 15);
    assert.equal(duracaoTesteDias({ ASSINATURA_TESTE_DIAS: ' 30 ' }), 30);
    assert.equal(duracaoTesteDias({ ASSINATURA_TESTE_DIAS: '1' }), 1);
    assert.equal(duracaoTesteDias({ ASSINATURA_TESTE_DIAS: '90' }), 90);
    for (const ruim of ['0', '91', '15.5', '-3', 'quinze', '1e1'])
        assert.throws(() => duracaoTesteDias({ ASSINATURA_TESTE_DIAS: ruim }), ConfiguracaoComercialInvalida, ruim);
});

test('preço por ciclo: só o configurado, em centavos; sem preço não há checkout; nada inventado', () => {
    assert.equal(precoDoCiclo('MENSAL', {}), null);
    assert.equal(precoDoCiclo('ANUAL', {}), null);
    assert.equal(precoDoCiclo('MENSAL', { ASSINATURA_PRECO_MENSAL_CENTAVOS: '12990' }), 12990);
    assert.equal(precoDoCiclo('ANUAL', { ASSINATURA_PRECO_MENSAL_CENTAVOS: '12990' }), null, 'um ciclo não empresta o preço do outro');
    for (const ruim of ['99', '129,90', '10000001'])
        assert.throws(() => precoDoCiclo('MENSAL', { ASSINATURA_PRECO_MENSAL_CENTAVOS: ruim }), ConfiguracaoComercialInvalida, ruim);
});
