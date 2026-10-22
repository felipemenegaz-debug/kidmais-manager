import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { causaDoErro, chaveDaOrigem, formatoDaOrigem, ipPublico, normalizarIp, origemConfiavel, registrarFormatoDaOrigem } from './origem-cliente.ts';
import { opcoesDoPool, POOL_PADRAO } from '../db/postgres.ts';

const RENDER = { RENDER: 'true' };
const req = (h: Record<string, string>) => ({ headers: { get: (n: string) => h[n.toLowerCase()] ?? null } });

test('origem: só no Render, e só o ÚLTIMO X-Forwarded-For (o começo da lista é do cliente)', () => {
    assert.equal(origemConfiavel(req({ 'x-forwarded-for': '177.10.20.30' }), RENDER), '177.10.20.30');
    assert.equal(origemConfiavel(req({ 'x-forwarded-for': '1.2.3.4, 177.10.20.30' }), RENDER), '177.10.20.30');
    assert.equal(origemConfiavel(req({ 'x-forwarded-for': '177.10.20.30' }), {}), null, 'fora do Render não há proxy confiável');
    assert.equal(origemConfiavel(req({ 'x-forwarded-for': '177.10.20.30' }), { RENDER: 'false' }), null);
});

test('origem: cabeçalho forjado não escolhe a chave (XFF no início, True-Client-IP e CF-Connecting-IP)', () => {
    // O cliente manda o IP de outra empresa no começo e nos cabeçalhos da Cloudflare; o proxy acrescenta o real no fim.
    const forjado = req({ 'x-forwarded-for': '189.6.16.247, 200.200.200.200', 'true-client-ip': '189.6.16.247', 'cf-connecting-ip': '189.6.16.247' });
    assert.equal(origemConfiavel(forjado, RENDER), '200.200.200.200');
    // Sem X-Forwarded-For, True-Client-IP sozinho não vale.
    assert.equal(origemConfiavel(req({ 'true-client-ip': '189.6.16.247' }), RENDER), null);
    assert.equal(origemConfiavel(req({ 'x-forwarded-for': '177.10.20.30, nao-e-ip' }), RENDER), null);
    assert.equal(origemConfiavel(req({ 'x-forwarded-for': '' }), RENDER), null);
});

test('origem: salto interno/reservado no fim vira null (nunca uma chave compartilhada por todos)', () => {
    for (const fim of ['10.1.2.3', '172.20.0.1', '192.168.0.10', '127.0.0.1', '100.64.1.1', '169.254.1.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::5', '2001:db8::1', '198.51.100.7'])
        assert.equal(origemConfiavel(req({ 'x-forwarded-for': `177.10.20.30, ${fim}` }), RENDER), null, fim);
    assert.ok(ipPublico('8.8.8.8') && ipPublico('2804:14c:1::1') && !ipPublico('224.0.0.1'));
});

test('origem: normalização e agrupamento IPv6 por /64', () => {
    assert.equal(normalizarIp('::ffff:177.10.20.30'), '177.10.20.30');
    assert.equal(normalizarIp(' [2804:14C:65::1] '), '2804:14c:65::1');
    assert.equal(normalizarIp('177.10.20.30:443'), null);
    assert.equal(chaveDaOrigem('177.10.20.30'), '177.10.20.30');
    assert.equal(chaveDaOrigem('2804:14c:65:a1::1'), '2804:14c:65:a1::/64');
    assert.equal(chaveDaOrigem('2804:14c:65:a1:ffff:1:2:3'), '2804:14c:65:a1::/64');
    assert.equal(chaveDaOrigem('2804:14c::9'), '2804:14c:0:0::/64');
    assert.notEqual(chaveDaOrigem('2804:14c:65:a1::1'), chaveDaOrigem('2804:14c:65:a2::1'));
});

test('formato da origem: diagnóstico sem nenhum endereço', () => {
    const f = formatoDaOrigem(req({ 'x-forwarded-for': '1.2.3.4, 177.10.20.30', 'true-client-ip': '177.10.20.30', 'cf-connecting-ip': '1.2.3.4' }), RENDER);
    assert.deepEqual(f, { render: true, valoresNoEncaminhamento: 2, ultimo: 'publico', trueClientIp: 'igual-ao-ultimo', cfConnectingIp: 'outra-posicao' });
    const linhas: string[] = [];
    registrarFormatoDaOrigem(req({ 'x-forwarded-for': '177.10.20.30, 10.0.0.1' }), null, RENDER, (m) => linhas.push(m));
    registrarFormatoDaOrigem(req({ 'x-forwarded-for': '177.10.20.30' }), '177.10.20.30', RENDER, (m) => linhas.push(m));
    assert.equal(linhas.length, 1, 'formato normal: uma vez por processo');
    assert.match(linhas[0], /origem não confiável/);
    assert.doesNotMatch(linhas.join('\n'), /177\.10|10\.0\.0/);
});

test('causa do 500 vai ao log sem e-mail e sem texto longo', () => {
    const c = causaDoErro(Object.assign(new Error('timeout exceeded when trying to connect para pessoa@exemplo.test'), { code: 'ETIMEDOUT' }));
    assert.deepEqual(c, { nome: 'Error', codigo: 'ETIMEDOUT', mensagem: 'timeout exceeded when trying to connect para <email>' });
    assert.equal(causaDoErro(undefined).nome, 'undefined');
    assert.ok((causaDoErro(new Error('x'.repeat(999))).mensagem ?? '').length <= 200);
});

test('pool: padrão 30 / 10 s, valor inválido cai no padrão, teto 40', () => {
    assert.deepEqual(opcoesDoPool({}), { max: 30, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
    assert.equal(opcoesDoPool({ DATABASE_POOL_MAX: '12' }).max, 12);
    assert.equal(opcoesDoPool({ DATABASE_POOL_MAX: '500' }).max, POOL_PADRAO.teto);
    for (const ruim of ['0', '-1', 'abc', '1e3', ''])
        assert.equal(opcoesDoPool({ DATABASE_POOL_MAX: ruim }).max, 30, ruim);
    assert.equal(opcoesDoPool({ DATABASE_CONNECTION_TIMEOUT_MS: 'NaN' }).connectionTimeoutMillis, 10_000);
});

test('rota de login passa o IP confiável (não null) e o serviço não tem chave global de origem', () => {
    const rota = readFileSync('app/api/admin/autenticacao/route.ts', 'utf8');
    assert.match(rota, /loginAdmin\(body\.data\.email, body\.data\.senha, randomUUID\(\), ip, userAgent\)/);
    assert.match(rota, /reautenticarAdmin\(tokenAdmin\(request\), body\.data\.senha, ip, userAgent\)/);
    const servico = readFileSync('lib/autenticacao/service.ts', 'utf8');
    const login = servico.slice(servico.indexOf('export async function loginAdmin('), servico.indexOf('export async function logoutAdmin'));
    assert.doesNotMatch(login, /ORIGEM_NAO_VERIFICADA/);
    // O scrypt roda fora de transação: conferirSenha aparece antes da transação do resultado, não dentro de outra.
    const antes = login.slice(0, login.indexOf('conferirSenha('));
    assert.equal((antes.match(/withTransaction\(/g) ?? []).length, 1, 'só a transação curta dos limites antes do scrypt');
    assert.ok(antes.lastIndexOf('});') > antes.lastIndexOf('withTransaction('), 'a transação dos limites termina antes do scrypt');
});
