/* eslint-disable @typescript-eslint/no-require-imports */
// Usuários sintéticos na transação/banco do chamador; login real, sem bypass.
const { randomBytes, randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
require('./pagamentos-test-support.cjs');
const { NextRequest } = require('next/server');
async function autenticarTeste(c, origin = 'http://localhost:3000') {
    process.env.ADMIN_AUTH_ORIGIN = origin;
    process.env.ADMIN_AUTH_SECRET = randomBytes(32).toString('hex');
    const { criarHashSenha } = require('../lib/autenticacao/senha.ts');
    const senha = randomBytes(24).toString('base64url'), email = `${randomUUID()}@example.invalid`;
    const usuarioId = (await c.query(`INSERT INTO usuarios_administrativos(email,nome,papel,senha_hash)
 VALUES($1,'Representante sintético','REPRESENTANTE_AUTORIZADO',$2) RETURNING id`, [email, await criarHashSenha(senha)])).rows[0].id;
    const auth = require('../app/api/admin/autenticacao/route.ts');
    const jar = new Map();
    let csrf = '';
    const headers = () => ({ 'Content-Type': 'application/json', origin, 'x-csrf-token': csrf, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') });
    const request = (path, method = 'GET', body) => new NextRequest(origin + path, { method, headers: headers(), ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
    for (const [method, body] of [['GET', undefined], ['POST', { acao: 'login', email, senha }]]) {
        const r = await auth[method](request('/api/admin/autenticacao', method, body));
        const j = await r.json();
        assert.equal(r.status, 200, JSON.stringify(j));
        for (const cookie of r.headers.getSetCookie()) {
            const pair = cookie.split(';')[0], at = pair.indexOf('=');
            jar.set(pair.slice(0, at), pair.slice(at + 1));
        }
        if (j.data?.csrf)
            csrf = j.data.csrf;
    }
    return { usuarioId, token: jar.get('kidmais_admin_dev'), headers, request };
}
module.exports = { autenticarTeste };
