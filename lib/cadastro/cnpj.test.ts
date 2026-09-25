import assert from 'node:assert/strict';
import test from 'node:test';

import { cnpjFormatoDvOficial, cnpjRaizPlaceholder, cnpjValido, normalizarCnpj } from './cnpj.ts';

test('normaliza pontuação permitida, letras minúsculas e preserva zeros iniciais', () => {
    assert.equal(normalizarCnpj('00.000.000/0001-91'), '00000000000191');
    assert.equal(normalizarCnpj('  12.abc.345/01de-35  '), '12ABC34501DE35');
    assert.equal(normalizarCnpj(null), '');
});

test('aceita CNPJ numérico e alfanumérico sintéticos com máscara ou sem', () => {
    assert.equal(cnpjValido('11.222.333/0001-81'), true);
    assert.equal(cnpjValido('11222333000181'), true);
    assert.equal(cnpjValido('00.000.000/0001-91'), true);
    assert.equal(cnpjValido('12.ABC.345/01DE-35'), true);
    assert.equal(cnpjValido('12abc34501de35'), true);
    assert.equal(cnpjValido('12ABC34501DE35'), true);
    assert.equal(cnpjValido('20000000000107'), true);
    assert.equal(cnpjValido('ABCDEF00000160'), true);
});

test('recusa dígitos verificadores inválidos', () => {
    assert.equal(cnpjValido('11.222.333/0001-80'), false);
    assert.equal(cnpjValido('11.222.333/0001-71'), false);
    assert.equal(cnpjValido('12.ABC.345/01DE-00'), false);
    assert.equal(cnpjValido('12.ABC.345/01DE-36'), false);
});

test('raiz repetida com DV correto passa no formato oficial e fica só na rejeição de placeholder', () => {
    assert.equal(cnpjFormatoDvOficial('00000000000000'), true);
    assert.equal(cnpjValido('00.000.000/0000-00'), true);
    assert.equal(cnpjRaizPlaceholder('00000000000000'), true);
    assert.equal(cnpjFormatoDvOficial('00000000000001'), false);
    assert.equal(cnpjRaizPlaceholder('00000000000001'), true);
    assert.equal(cnpjRaizPlaceholder('11.222.333/0001-81'), false);
});

test('recusa entrada incompleta', () => {
    assert.equal(cnpjValido(''), false);
    assert.equal(cnpjValido('   '), false);
    assert.equal(cnpjValido(undefined), false);
    assert.equal(cnpjValido('11.222.333/0001'), false);
    assert.equal(cnpjValido('12.ABC.345/01DE-3'), false);
    assert.equal(cnpjValido('1122233300018'), false);
});

test('recusa caracteres indevidos e DV não numérico', () => {
    assert.equal(cnpjValido('11.222.333/0001-8A'), false);
    assert.equal(cnpjValido('12_ABC_345_01DE_35'), false);
    assert.equal(cnpjValido('12.ABC.345/01DE-35!'), false);
    assert.equal(cnpjValido('12ABC34501DE350'), false);
    assert.equal(cnpjValido('CNPJ:12ABC34501DE35'), false);
});
