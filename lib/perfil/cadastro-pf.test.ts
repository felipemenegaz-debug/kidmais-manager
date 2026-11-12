import assert from 'node:assert/strict';
import test from 'node:test';
import { campoExigidoNaAplicacao, validarAplicacao, type CadastroPerfil } from './cadastro.ts';

/** Contratante pessoa física (091): o Perfil aplica sem CNPJ; CNPJ informado continua validado; CPF nunca vai para o Perfil. */
const base = (o: Partial<CadastroPerfil> = {}): Partial<CadastroPerfil> => ({
    nomeComercial: 'Buffet da Maria', razaoSocial: 'Maria Sintética da Silva', cnpj: '', unidadeNome: 'Buffet da Maria', mesmoEnderecoSede: true,
    sede: { cep: '01001000', logradouro: 'Praça da Sé', numero: '1', semNumero: false, complemento: '', bairro: 'Sé', cidade: 'São Paulo', uf: 'SP', pais: 'BR' },
    telefone: '11999990000', whatsapp: '11999990000', emailComercial: 'contato@exemplo.test', ...o,
} as Partial<CadastroPerfil>);
const campos = (v: ReturnType<typeof validarAplicacao>) => v.falhas.map((f) => f.campo);

test('PJ continua exigindo CNPJ e razão social ao aplicar', () => {
    assert.ok(campos(validarAplicacao(base())).includes('cnpj'));
    assert.equal(campoExigidoNaAplicacao('cnpj', true), true);
    assert.match(validarAplicacao(base({ razaoSocial: '' })).falhas.find((f) => f.campo === 'razaoSocial')!.mensagem, /razão social/);
});

test('PF aplica sem CNPJ; CNPJ informado precisa ser válido; nome civil obrigatório', () => {
    assert.deepEqual(validarAplicacao(base(), { pessoaFisica: true }).falhas, []);
    assert.equal(campoExigidoNaAplicacao('cnpj', true, true), false);
    assert.equal(campoExigidoNaAplicacao('razaoSocial', true, true), true);
    assert.ok(campos(validarAplicacao(base({ cnpj: '11222333000182' }), { pessoaFisica: true })).includes('cnpj'));
    assert.ok(campos(validarAplicacao(base({ cnpj: '52998224725' }), { pessoaFisica: true })).includes('cnpj'), 'CPF não entra no campo de CNPJ');
    assert.deepEqual(validarAplicacao(base({ cnpj: '11.222.333/0001-81' }), { pessoaFisica: true }).falhas, []);
    assert.match(validarAplicacao(base({ razaoSocial: '' }), { pessoaFisica: true }).falhas[0]!.mensagem, /nome civil/);
});
