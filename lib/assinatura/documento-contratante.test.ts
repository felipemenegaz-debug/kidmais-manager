import assert from 'node:assert/strict';
import test from 'node:test';
import type { DbExecutor } from '../db/contracts';
import { cpfValido, documentoFiscalValido, normalizarDocumentoFiscal, tipoDocumentoFiscal } from '../acessos/validacao.ts';
import { cpfContratacaoLigado, exigirDocumentoContratante } from './documento-contratante.ts';

/** CPFs e CNPJs SINTÉTICOS com DV calculado (não são documentos de pessoas reais conhecidas). */
test('CPF: zeros à esquerda, os dois DVs, sequência repetida, máscara e caracteres estranhos', () => {
    assert.equal(cpfValido('52998224725'), true);
    assert.equal(cpfValido('00000000191'), true, 'zeros à esquerda contam');
    assert.equal(cpfValido('52998224715'), false, '1º DV errado');
    assert.equal(cpfValido('52998224724'), false, '2º DV errado');
    for (const d of ['00000000000', '11111111111', '99999999999']) assert.equal(cpfValido(d), false, d);
    assert.equal(cpfValido('5299822472'), false); assert.equal(cpfValido('529982247250'), false);
    assert.deepEqual(documentoFiscalValido('529.982.247-25'), { numero: '52998224725', tipo: 'CPF' });
    assert.deepEqual(documentoFiscalValido(' 000.000.001-91 '), { numero: '00000000191', tipo: 'CPF' });
    for (const d of ['529.982.247/25', '529x982x247x25', '52998224725a', '', null, undefined, '529 982 247 2 5 9'])
        assert.equal(documentoFiscalValido(d), null, String(d));
});

test('CNPJ numérico e alfanumérico preservados; raiz repetida recusada; tipo pela forma normalizada', () => {
    assert.deepEqual(documentoFiscalValido('00.000.000/0001-91'), { numero: '00000000000191', tipo: 'CNPJ' });
    assert.deepEqual(documentoFiscalValido('12.abc.345/01de-35'), { numero: '12ABC34501DE35', tipo: 'CNPJ' });
    assert.equal(documentoFiscalValido('12ABC34501DE34'), null);
    assert.equal(documentoFiscalValido('11111111111180'), null, 'raiz repetida é placeholder');
    assert.equal(normalizarDocumentoFiscal(''), null);
    assert.throws(() => normalizarDocumentoFiscal('123'), /CPF ou CNPJ inválido/);
    assert.equal(tipoDocumentoFiscal('52998224725'), 'CPF'); assert.equal(tipoDocumentoFiscal('12ABC34501DE35'), 'CNPJ'); assert.equal(tipoDocumentoFiscal('123'), null);
});

class Db implements DbExecutor {
    instalado: boolean;
    constructor(instalado: boolean) { this.instalado = instalado; }
    sql: string[] = [];
    async query<Row extends object>(sql: string) {
        this.sql.push(sql);
        if (sql.includes('AS instalado091')) return { rows: [{ instalado091: this.instalado }] as unknown as Row[], rowCount: 1 };
        throw new Error('SQL não modelado: ' + sql);
    }
}
const LIGADO = { ASSINATURA_CPF_ATIVO: 'true' };
test('CPF só com a 091 instalada E a chave literal; CNPJ não consulta o banco; tipo esperado é exigido', async () => {
    assert.equal(cpfContratacaoLigado(LIGADO), true);
    for (const v of [undefined, 'TRUE', '1', ' true']) assert.equal(cpfContratacaoLigado({ ASSINATURA_CPF_ATIVO: v }), false);
    const sem = new Db(false), com = new Db(true);
    await assert.rejects(exigirDocumentoContratante(sem, '52998224725', LIGADO), (e: { code?: string }) => e.code === 'CPF_INDISPONIVEL');
    await assert.rejects(exigirDocumentoContratante(com, '52998224725', {}), (e: { code?: string }) => e.code === 'CPF_INDISPONIVEL');
    assert.deepEqual(await exigirDocumentoContratante(com, '52998224725', LIGADO), { numero: '52998224725', tipo: 'CPF' });
    const cnpj = new Db(false);
    assert.deepEqual(await exigirDocumentoContratante(cnpj, '00000000000191', {}), { numero: '00000000000191', tipo: 'CNPJ' });
    assert.equal(cnpj.sql.length, 0, 'CNPJ não depende da 091');
    await assert.rejects(exigirDocumentoContratante(com, '00000000000191', LIGADO, 'CPF'), /CPF inválido/);
    await assert.rejects(exigirDocumentoContratante(com, '52998224725', LIGADO, 'CNPJ'), /CNPJ inválido/);
    await assert.rejects(exigirDocumentoContratante(com, '52998224724', LIGADO), (e: { code?: string }) => e.code === 'DADOS_INVALIDOS');
});
