import assert from 'node:assert/strict';
import test from 'node:test';
import { cadastroVazio } from './cadastro.ts';
import { aplicarConsultaCep, cepCompleto, type PedidoCep } from './consulta-cep.ts';

const pedido: PedidoCep = { cep: '01001000', logradouro: '', bairro: '', cidade: '', uf: '' };
const resposta = { cep: '01001000', logradouro: 'Praça da Sé', bairro: 'Sé', cidade: 'São Paulo', uf: 'SP' };

test('CEP completo dispara o preenchimento só de logradouro, bairro, cidade e UF', () => {
    assert.equal(cepCompleto('01001-000'), '01001000');
    assert.equal(cepCompleto('0100100'), null);
    const atual = { ...cadastroVazio().sede, cep: '01001000', numero: '12', complemento: 'Loja' };
    const preenchido = aplicarConsultaCep(atual, pedido, resposta);
    assert.equal(preenchido.logradouro, 'Praça da Sé');
    assert.equal(preenchido.bairro, 'Sé');
    assert.equal(preenchido.cidade, 'São Paulo');
    assert.equal(preenchido.uf, 'SP');
    assert.equal(preenchido.numero, '12');
    assert.equal(preenchido.complemento, 'Loja');
});

test('resposta atrasada ou CEP alterado não cobre edição manual', () => {
    const editado = { ...cadastroVazio().sede, cep: '01001000', logradouro: 'Rua digitada', numero: '9' };
    const preservado = aplicarConsultaCep(editado, pedido, resposta);
    assert.equal(preservado.logradouro, 'Rua digitada');
    assert.equal(preservado.bairro, 'Sé');
    assert.equal(preservado.numero, '9');
    const outroCep = { ...editado, cep: '02002000' };
    const trocado = aplicarConsultaCep(outroCep, pedido, resposta);
    assert.equal(trocado, outroCep);
    assert.equal(trocado.logradouro, 'Rua digitada');
    assert.equal(trocado.bairro, '');
    assert.equal(aplicarConsultaCep(editado, pedido, null).logradouro, 'Rua digitada');
});
