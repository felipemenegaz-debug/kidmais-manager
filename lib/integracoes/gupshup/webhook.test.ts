import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parseGupshupV2 } from './parser.ts';
import type { EventoSanitizado } from './parser.ts';
import { MAX_BODY_BYTES, receiveGupshupWebhook, SECRET_HEADER } from './webhook.ts';

const secret = 'synthetic-webhook-test-secret-not-real-123';
const env = { GUPSHUP_WEBHOOK_SECRET: secret, KIDMAIS_DEPLOY_ENV: 'staging' };
const event = (status = 'sent') => ({
    app: 'KidmaisManager', timestamp: 1789550000000, version: 2, type: 'message-event',
    payload: { id: 'synthetic-message-id', type: status, destination: '5511999990000', payload: {} },
});
function request(body: unknown = event(), headers: Record<string, string> = {}) {
    return new Request('https://staging.example/api/integracoes/gupshup/webhook', {
        method: 'POST', headers: { 'Content-Type': 'application/json', [SECRET_HEADER]: secret, ...headers },
        body: JSON.stringify(body),
    });
}
const receive = (req = request(), config = env) => receiveGupshupWebhook(req, config, () => {});

test('secret correto: 204 vazio, no-store, sem sessão/cookie/Origin', async () => {
    const response = await receive();
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('cache-control'), 'no-store');
});

for (const value of [undefined, 'wrong', `${secret}, ${secret}`]) {
    test(`secret ${value === undefined ? 'ausente' : value === 'wrong' ? 'incorreto' : 'duplicado'}: 401 sem ler corpo`, async () => {
        const req = request();
        if (value === undefined) req.headers.delete(SECRET_HEADER);
        else req.headers.set(SECRET_HEADER, value);
        const result = await receive(req);
        assert.equal(result.status, 401);
        assert.equal(req.bodyUsed, false);
    });
}

test('configuração ausente/fraca e ambiente fora de staging: fail closed', async () => {
    for (const GUPSHUP_WEBHOOK_SECRET of ['', 'weak', ' '.repeat(32)]) {
        assert.equal((await receive(request(), { ...env, GUPSHUP_WEBHOOK_SECRET })).status, 503);
    }
    for (const KIDMAIS_DEPLOY_ENV of ['', 'production', 'unknown']) {
        assert.equal((await receive(request(), { ...env, KIDMAIS_DEPLOY_ENV })).status, 503);
    }
});

for (const status of ['enqueued', 'failed', 'sent', 'delivered', 'read']) {
    test(`${status}: parser puro e endpoint aceitam evento v2`, async () => {
        const logs: EventoSanitizado[] = [];
        const input = event(status);
        const original = JSON.stringify(input);
        assert.equal(parseGupshupV2(input)?.status, status);
        assert.equal(JSON.stringify(input), original);
        assert.equal((await receiveGupshupWebhook(request(input), env, (log) => { logs.push(log); })).status, 204);
        assert.equal(logs[0].status, status);
        assert.equal(logs[0].destinationMasked, '***00');
        assert.match(logs[0].messageIdHash!, /^[a-f0-9]{16}$/);
    });
}

test('inbound message: aceita conteúdo, mas não retorna nem registra conteúdo/remetente', async () => {
    const input = { ...event(), type: 'message', payload: {
        id: 'synthetic-inbound-id', type: 'text', source: '5511987654321',
        sender: { name: 'Synthetic Private Name', phone: '5511987654321' },
        payload: { text: 'PRIVATE TEXT', url: 'https://private.example/media', token: 'synthetic-private-token' },
    } };
    let logged: EventoSanitizado | undefined;
    const response = await receiveGupshupWebhook(request(input), env, (log) => { logged = log; });
    assert.equal(response.status, 204);
    assert.equal(logged?.status, 'received');
    assert.deepEqual(Object.keys(logged!).sort(), ['eventType', 'messageIdHash', 'status', 'timestamp']);
    const output = JSON.stringify(logged) + await response.text();
    for (const value of ['PRIVATE TEXT', 'Synthetic Private Name', '5511987654321', 'synthetic-private-token', 'synthetic-inbound-id', 'private.example', secret]) {
        assert.ok(!output.includes(value));
    }
});

test('failed: motivo, destino integral e campos arbitrários nunca saem nos logs', async () => {
    const input = event('failed');
    input.payload.payload = { reason: 'PRIVATE FAILURE', password: secret };
    let logged: EventoSanitizado | undefined;
    await receiveGupshupWebhook(request(input), env, (log) => { logged = log; });
    const output = JSON.stringify(logged);
    for (const value of ['PRIVATE FAILURE', secret, input.payload.id, input.payload.destination]) assert.ok(!output.includes(value));
});

test('eventos desconhecidos são ignorados com 204 e sem refletir strings arbitrárias', async () => {
    for (const input of [{ ...event(), type: 'unknown-private-type' }, event('unknown-private-status')]) {
        let logged: EventoSanitizado | undefined;
        assert.equal((await receiveGupshupWebhook(request(input), env, (log) => { logged = log; })).status, 204);
        assert.equal(logged?.status, 'ignored');
        assert.ok(!JSON.stringify(logged).includes('private'));
    }
});

test('payload inválido, app diferente, versão incorreta e envelope incompleto: 400 sem log', async () => {
    for (const input of [null, [], {}, { ...event(), app: 'Other' }, { ...event(), version: 1 },
        { ...event(), version: '2' }, { ...event(), timestamp: -1 }, { ...event(), timestamp: '123' },
        { ...event(), payload: null }, { ...event(), payload: { type: 'sent' } }]) {
        assert.equal((await receiveGupshupWebhook(request(input), env, () => assert.fail('Must not log'))).status, 400);
    }
    const malformed = new Request(request(), { body: '{invalid' });
    assert.equal((await receive(malformed)).status, 400);
});

test('form urlencoded: campos do envelope e message com JSON completo', async () => {
    const input = event();
    const forms = [new URLSearchParams({ ...input, timestamp: String(input.timestamp), version: '2', payload: JSON.stringify(input.payload) }),
        new URLSearchParams({ message: JSON.stringify(input) })];
    for (const form of forms) {
        assert.equal((await receive(new Request(request(), {
            body: form.toString(), headers: { [SECRET_HEADER]: secret, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        }))).status, 204);
    }
});

test('form ambíguo ou JSON inválido: 400', async () => {
    for (const form of ['message=%7B', 'message=%7B%7D&message=%7B%7D', 'message=%7B%7D&app=Other']) {
        assert.equal((await receive(new Request(request(), {
            body: form, headers: { [SECRET_HEADER]: secret, 'content-type': 'application/x-www-form-urlencoded' },
        }))).status, 400);
    }
});

test('Content-Type e compressão não suportados: 415', async () => {
    assert.equal((await receive(request(event(), { 'content-type': 'text/plain' }))).status, 415);
    assert.equal((await receive(request(event(), { 'content-encoding': 'gzip' }))).status, 415);
});

test('limite de payload declarado e real (inclusive sem content-length): 413', async () => {
    assert.equal((await receive(request(event(), { 'content-length': String(MAX_BODY_BYTES + 1) }))).status, 413);
    assert.equal((await receive(request({ data: 'x'.repeat(MAX_BODY_BYTES) }))).status, 413);
    assert.equal((await receive(request({ data: 'x'.repeat(MAX_BODY_BYTES) }, { 'content-length': '1' }))).status, 413);
});

test('stream lento: interrompe leitura em 3 segundos sem log', { timeout: 5000 }, async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const init: RequestInit & { duplex: string } = {
        method: 'POST', body, duplex: 'half',
        headers: { [SECRET_HEADER]: secret, 'content-type': 'application/json' },
    };
    const response = await receiveGupshupWebhook(new Request('https://staging.example/webhook', init), env,
        () => assert.fail('Must not log'));
    assert.equal(response.status, 408);
    assert.equal(cancelled, true);
});

test('HTTPS: proxy Render staging válido; HTTP, proto múltiplo/ausente e proxy externo recusados', async () => {
    const renderEnv = { ...env, RENDER: 'true' };
    const internal = () => new Request('http://internal:3000/api/integracoes/gupshup/webhook', request());
    for (const proto of [null, 'http', 'https,http']) {
        const req = internal();
        if (proto) req.headers.set('x-forwarded-proto', proto);
        assert.equal((await receiveGupshupWebhook(req, renderEnv, () => {})).status, 403);
    }
    const req = internal();
    req.headers.set('x-forwarded-proto', 'https');
    assert.equal((await receiveGupshupWebhook(req, renderEnv, () => {})).status, 204);
    const externalProxy = internal();
    externalProxy.headers.set('x-forwarded-proto', 'https');
    assert.equal((await receive(externalProxy)).status, 403);
});

test('ACK rápido: agenda somente metadados sem executar trabalho pós-resposta', { timeout: 2000 }, async () => {
    const queued: EventoSanitizado[] = [];
    const start = performance.now();
    const response = await receiveGupshupWebhook(request(), env, (log) => { queued.push(log); });
    assert.equal(response.status, 204);
    assert.ok(performance.now() - start < 1000);
    assert.equal(queued.length, 1);
    // Route adapter explicitly schedules the log after the HTTP response.
    const route = readFileSync(new URL('../../../app/api/integracoes/gupshup/webhook/route.ts', import.meta.url), 'utf8');
    assert.match(route, /after\(\(\) =>/);
    assert.doesNotMatch(route, /export (?:async )?function GET/);
});

test('retries não têm efeitos de negócio ou persistência', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await receive()).status, 204);
});
