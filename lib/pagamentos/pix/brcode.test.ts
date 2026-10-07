import assert from 'node:assert/strict';
import test from 'node:test';
import { crc16, mascararChavePix, montarBrCodeEstatico, normalizarChavePix, qrSvg, textoBrCode, txidDaParcela } from './brcode.ts';

test('BR Code estático: reproduz o exemplo oficial do Manual de Padrões para Iniciação do Pix (CRC 1D3D)', () => {
    const payload = montarBrCodeEstatico({ chave: '123e4567-e12b-12d1-a456-426655440000', nomeRecebedor: 'Fulano de Tal', cidadeRecebedor: 'BRASILIA' });
    assert.equal(payload, '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D');
});

test('BR Code com valor e txid: campos 54 e 62/05 corretos; CRC confere com o restante do payload', () => {
    const payload = montarBrCodeEstatico({ chave: '+5511999998888', nomeRecebedor: 'Buffet Alegria Ltda', cidadeRecebedor: 'São Paulo', valorCentavos: 150050, txid: 'KMABC123' });
    assert.match(payload, /54071500\.50/);
    assert.match(payload, /6009Sao Paulo/);
    assert.match(payload, /62120508KMABC123/);
    assert.equal(payload.slice(-4), crc16(payload.slice(0, -4)));
    assert.equal(crc16('123456789'), '29B1', 'vetor de verificação do CRC-16/CCITT-FALSE');
});

test('limites: nome 25, cidade 15, sem acentos; valor inválido e dados faltando recusados', () => {
    assert.equal(textoBrCode('Ação Infantil Comércio de Festas e Eventos', 25), 'Acao Infantil Comercio de');
    assert.ok(textoBrCode('São José dos Campos', 15).length <= 15);
    for (const valorCentavos of [0, -1, 10.5])
        assert.throws(() => montarBrCodeEstatico({ chave: 'a@b.com', nomeRecebedor: 'X', cidadeRecebedor: 'Y', valorCentavos }));
    assert.throws(() => montarBrCodeEstatico({ chave: '', nomeRecebedor: 'X', cidadeRecebedor: 'Y' }));
    assert.throws(() => montarBrCodeEstatico({ chave: 'a@b.com', nomeRecebedor: '', cidadeRecebedor: 'Y' }));
});

test('txid da parcela: só alfanumérico, até 25, prefixo KM; vazio vira ***', () => {
    const txid = txidDaParcela('0f8c2a1e-3b4d-4e5f-8a9b-0c1d2e3f4a5b');
    assert.match(txid, /^KM[A-Z0-9]{23}$/);
    assert.equal(txidDaParcela(''), '***');
    const payload = montarBrCodeEstatico({ chave: 'a@b.com', nomeRecebedor: 'X', cidadeRecebedor: 'Y', txid: 'com-hifen' });
    assert.match(payload, /0503\*\*\*/, 'txid inválido não entra no payload');
});

test('chave Pix: normalização e recusa por tipo', () => {
    assert.deepEqual(normalizarChavePix('CPF', '529.982.247-25'), { tipo: 'CPF', chave: '52998224725' });
    assert.equal(normalizarChavePix('CPF', '111.111.111-11'), null);
    assert.equal(normalizarChavePix('CPF', '529.982.247-24'), null);
    assert.deepEqual(normalizarChavePix('CNPJ', '11.222.333/0001-81'), { tipo: 'CNPJ', chave: '11222333000181' });
    assert.equal(normalizarChavePix('CNPJ', '11.222.333/0001-80'), null);
    assert.deepEqual(normalizarChavePix('EMAIL', ' Financeiro@Buffet.COM.br '), { tipo: 'EMAIL', chave: 'financeiro@buffet.com.br' });
    assert.equal(normalizarChavePix('EMAIL', 'sem-arroba'), null);
    assert.deepEqual(normalizarChavePix('TELEFONE', '(11) 99999-8888'), { tipo: 'TELEFONE', chave: '+5511999998888' });
    assert.deepEqual(normalizarChavePix('TELEFONE', '+55 11 3333-4444'), { tipo: 'TELEFONE', chave: '+551133334444' });
    assert.equal(normalizarChavePix('TELEFONE', '999'), null);
    assert.deepEqual(normalizarChavePix('ALEATORIA', '123E4567-E12B-12D1-A456-426655440000'), { tipo: 'ALEATORIA', chave: '123e4567-e12b-12d1-a456-426655440000' });
    assert.equal(normalizarChavePix('ALEATORIA', 'nao-e-uuid'), null);
});

test('máscara: nunca a chave inteira', () => {
    assert.equal(mascararChavePix('CPF', '52998224725'), '*******4725');
    assert.equal(mascararChavePix('EMAIL', 'financeiro@buffet.com.br'), 'fi***@buffet.com.br');
    assert.equal(mascararChavePix('ALEATORIA', '123e4567-e12b-12d1-a456-426655440000'), '123e…0000');
});

test('QR: SVG gerado localmente, sem script nem referência externa', () => {
    const svg = qrSvg(montarBrCodeEstatico({ chave: 'a@b.com', nomeRecebedor: 'Buffet', cidadeRecebedor: 'Recife', valorCentavos: 1000 }));
    assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
    assert.doesNotMatch(svg, /<script|href=|xlink/i);
});
