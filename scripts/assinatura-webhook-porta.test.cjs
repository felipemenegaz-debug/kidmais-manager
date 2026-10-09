/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarPorta, ROTA } = require('./assinatura-webhook-porta.cjs');

test('entrada de homologação bloqueia painel, token inválido e corpos indevidos antes do app', async t => {
    const token = 'token-sintetico-exclusivo-para-teste-123';
    const chamadas = [];
    let status = 200;
    const servidor = criarPorta({ token, encaminhar: async (url, init) => {
        chamadas.push({ url, init });
        return new Response('conteudo-interno-nao-exposto', { status });
    } });
    await new Promise(ok => servidor.listen(0, '127.0.0.1', ok));
    t.after(() => new Promise(ok => { servidor.close(ok); servidor.closeAllConnections(); }));
    const base = `http://127.0.0.1:${servidor.address().port}`;
    const enviar = (rota = ROTA, extra = {}) => fetch(base + rota, {
        method: 'POST', headers: { 'content-type': 'application/json', 'asaas-access-token': token }, body: '{}', ...extra,
    });
    for (const rota of ['/admin/login', '/api/admin/autenticacao', ROTA + '?x=1', ROTA + '/'])
        assert.equal((await enviar(rota)).status, 404);
    assert.equal((await enviar(ROTA, { method: 'GET', body: undefined })).status, 405);
    assert.equal((await enviar(ROTA, { headers: { 'content-type': 'application/json' } })).status, 401);
    assert.equal((await enviar(ROTA, { headers: { 'asaas-access-token': 'incorreto' } })).status, 401);
    assert.equal((await enviar(ROTA, { headers: { 'asaas-access-token': token, 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await enviar(ROTA, { body: '{' })).status, 400);
    assert.equal((await enviar(ROTA, { body: 'x'.repeat(65537) })).status, 413);
    assert.equal(chamadas.length, 0);
    const resposta = await enviar(ROTA, { headers: {
        'content-type': 'application/json', 'asaas-access-token': token,
        cookie: 'sessao=falsa', 'x-forwarded-for': '1.2.3.4', origin: 'https://origem.invalid',
    } });
    assert.equal(resposta.status, 200);
    assert.equal(await resposta.text(), '');
    assert.equal(chamadas[0].url, 'http://127.0.0.1:3195' + ROTA);
    assert.deepEqual(Object.keys(chamadas[0].init.headers).sort(), ['asaas-access-token', 'content-type']);
    assert.equal(chamadas[0].init.redirect, 'error');
    status = 500;
    assert.equal((await enviar()).status, 503);
    status = 302;
    assert.equal((await enviar()).status, 503);
});

test('configuração recusa token curto e destino arbitrário', () => {
    assert.throws(() => criarPorta({ token: 'curto' }), /TOKEN_INVALIDO/);
    assert.throws(() => criarPorta({ token: 'x'.repeat(32), destino: 'http://127.0.0.1:3188' }), /DESTINO_INVALIDO/);
});
