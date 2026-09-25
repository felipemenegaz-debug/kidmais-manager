import assert from 'node:assert/strict';
import test from 'node:test';
import { alteracaoSensivel, cadastroVazio, campoExigidoNaAplicacao, contatoExigidoNaAplicacao, validarAplicacao, validarRascunho } from './cadastro.ts';

const endereco = {
    cep: '01001000',
    logradouro: 'Praça da Sé',
    numero: '100',
    semNumero: false,
    complemento: '',
    bairro: 'Sé',
    cidade: 'São Paulo',
    uf: 'SP',
    pais: 'BR',
};

function completo(parcial: Record<string, unknown> = {}) {
    return {
        nomeComercial: 'Kidmais',
        razaoSocial: 'Kidmais Festas Ltda',
        cnpj: '11.222.333/0001-81',
        sede: endereco,
        unidadeNome: 'Unidade Sé',
        mesmoEnderecoSede: false,
        unidade: { ...endereco, numero: '200' },
        telefone: '11999999999',
        whatsapp: '',
        emailComercial: '',
        site: '',
        instagram: '',
        referenciaChegada: '',
        ...parcial,
    };
}

test('rascunho aceita cadastro incompleto e recusa CNPJ inválido ou placeholder', () => {
    assert.equal(validarRascunho({ nomeComercial: 'Rascunho' }).falhas.length, 0);
    assert.equal(validarRascunho({ cnpj: '11.222.333/0001-80' }).falhas.some((falha) => falha.campo === 'cnpj'), true);
    assert.equal(validarRascunho({ cnpj: '00000000000000' }).falhas.some((falha) => falha.mensagem.includes('placeholder')), true);
});

test('sem número esvazia o número e a aplicação exige o restante do endereço', () => {
    const semNumero = validarAplicacao(completo({
        sede: { ...endereco, numero: '10', semNumero: true },
        mesmoEnderecoSede: true,
    }));
    assert.equal(semNumero.cadastro.sede.numero, '');
    assert.equal(semNumero.cadastro.mesmoEnderecoSede, true);
    assert.deepEqual(semNumero.cadastro.unidade, semNumero.cadastro.sede);
    assert.equal(semNumero.falhas.some((falha) => falha.campo === 'sede.numero'), false);

    const faltando = validarAplicacao(completo({
        sede: { ...endereco, numero: '', semNumero: false },
    }));
    assert.equal(faltando.falhas.some((falha) => falha.campo === 'sede.numero'), true);
});

test('aplicar distingue sede e unidade e marca alteração sensível', () => {
    const aplicado = validarAplicacao(completo());
    assert.equal(aplicado.falhas.length, 0);
    assert.notEqual(aplicado.cadastro.unidade.numero, aplicado.cadastro.sede.numero);
    const base = cadastroVazio();
    assert.equal(alteracaoSensivel(base, aplicado.cadastro), true);
    assert.equal(alteracaoSensivel(aplicado.cadastro, aplicado.cadastro), false);
});

test('o asterisco da aplicação não exige cada contato nem o complemento', () => {
    assert.equal(validarRascunho({}).falhas.length, 0);
    assert.equal(campoExigidoNaAplicacao('nomeComercial', false), true);
    assert.equal(campoExigidoNaAplicacao('sede.complemento', false), false);
    assert.equal(campoExigidoNaAplicacao('telefone', false), false);
    assert.equal(campoExigidoNaAplicacao('whatsapp', false), false);
    assert.equal(contatoExigidoNaAplicacao(), true);
    assert.equal(campoExigidoNaAplicacao('unidade.cep', true), false);
    assert.equal(campoExigidoNaAplicacao('unidade.logradouro', false), true);
    assert.equal(validarAplicacao(completo({ telefone: '', whatsapp: '11988887777' })).falhas.some((falha) => falha.campo === 'telefone'), false);
});

test('contato e links não aceitam script nem e-mail inválido', () => {
    const falhas = validarAplicacao(completo({
        telefone: '123',
        whatsapp: '',
        emailComercial: 'nao-e-email',
        site: 'javascript:alert(1)',
    })).falhas;
    assert.equal(falhas.some((falha) => falha.campo === 'telefone'), true);
    assert.equal(falhas.some((falha) => falha.campo === 'emailComercial'), true);
    assert.equal(falhas.some((falha) => falha.campo === 'site'), true);
});
