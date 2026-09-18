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

for (const value of ['', 'wrong', `${secret}, ${secret}`]) {
    test(`secret ${value === '' ? 'vazio' : value === 'wrong' ? 'incorreto' : 'duplicado'}: 401 sem ler corpo`, async () => {
        const req = request();
        req.headers.set(SECRET_HEADER, value);
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

const handshake = () => ({
    app: 'KidmaisManager', timestamp: 1789603200000, version: 2, type: 'user-event',
    payload: { type: 'sandbox-start', phone: '5511999990000' },
});
function withoutSecret(body: unknown) {
    const req = request(body);
    req.headers.delete(SECRET_HEADER);
    return req;
}

for (const authenticated of [false, true]) {
    test(`sandbox-start ${authenticated ? 'com secret correto' : 'sem secret'}: ACK 204 rápido e apenas log sanitizado`, async () => {
        const input = { ...handshake(), privateField: 'PRIVATE HANDSHAKE CONTENT' };
        const req = authenticated ? request(input) : withoutSecret(input);
        const logs: EventoSanitizado[] = [];
        const start = performance.now();
        const response = await receiveGupshupWebhook(req, env, (log) => { logs.push(log); });
        assert.equal(response.status, 204);
        assert.equal(await response.text(), '');
        assert.ok(performance.now() - start < 1000);
        assert.deepEqual(logs, [{ timestamp: input.timestamp, eventType: 'user-event', status: 'sandbox-start' }]);
    });
}

test('sandbox-start com header incorreto/vazio/duplicado não usa exceção pública', async () => {
    for (const value of ['wrong', '', `${secret}, ${secret}`]) {
        const req = request(handshake(), { [SECRET_HEADER]: value });
        assert.equal((await receiveGupshupWebhook(req, env, () => assert.fail('Must not log'))).status, 401);
        assert.equal(req.bodyUsed, false);
    }
});

test('sandbox-start malformado ou envelope inválido: 400 com e sem secret', async () => {
    for (const body of [null, [], {}, { ...handshake(), app: 'Other' },
        { ...handshake(), version: 1 }, { ...handshake(), version: '2' },
        { ...handshake(), timestamp: undefined }, { ...handshake(), timestamp: '123' },
        { ...handshake(), timestamp: -1 }, { ...handshake(), payload: null },
        { ...handshake(), payload: [] }, { ...handshake(), payload: {} },
        { ...handshake(), payload: { type: ['sandbox-start'] } }]) {
        for (const req of [request(body), withoutSecret(body)]) {
            assert.equal((await receiveGupshupWebhook(req, env, () => assert.fail('Must not log'))).status, 400);
        }
    }
    assert.equal((await receive(new Request(withoutSecret(handshake()), { body: '{invalid sandbox-start' }))).status, 400);
});

test('todos os demais eventos válidos sem secret continuam recusados, sem log', async () => {
    const events = [
        ...['enqueued', 'failed', 'sent', 'delivered', 'read'].map(event),
        { ...event(), type: 'message', payload: { ...event().payload, type: 'text' } },
        { ...event(), type: 'unknown' },
        ...['opted-in', 'opted-out', 'sandbox-start-extra', 'SANDBOX-START', ' sandbox-start', 'other']
            .map(type => ({ ...handshake(), payload: { type } })),
        { ...handshake(), type: 'message-event' },
        { ...handshake(), type: 'unknown', text: 'sandbox-start' },
        { ...handshake(), payload: { type: 'opted-in', payload: { type: 'sandbox-start' } } },
    ];
    for (const body of events) {
        assert.equal((await receiveGupshupWebhook(withoutSecret(body), env, () => assert.fail('Must not log'))).status, 401);
    }
    const headersOnly = withoutSecret(event());
    headersOnly.headers.set('X-Gupshup-Event', 'sandbox-start');
    assert.equal((await receive(headersOnly)).status, 401);
});

test('opted-in e opted-out autenticados mantêm ACK como eventos ignorados', async () => {
    for (const type of ['opted-in', 'opted-out']) {
        assert.equal((await receive(request({ ...handshake(), payload: { type } }))).status, 204);
    }
});

test('sandbox-start sem secret também aceita form validado e recusa campos duplicados', async () => {
    const input = handshake();
    const forms = [
        new URLSearchParams({ message: JSON.stringify(input) }),
        new URLSearchParams({ app: input.app, timestamp: String(input.timestamp), version: '2', type: input.type, payload: JSON.stringify(input.payload) }),
    ];
    for (const form of forms) {
        const req = new Request(withoutSecret(input), { body: form.toString() });
        req.headers.set('content-type', 'application/x-www-form-urlencoded');
        assert.equal((await receive(req)).status, 204);
    }
    const ambiguous = new Request(withoutSecret(input), {
        body: new URLSearchParams([['message', JSON.stringify(input)], ['message', JSON.stringify(event())]]).toString(),
    });
    ambiguous.headers.set('content-type', 'application/x-www-form-urlencoded');
    assert.equal((await receive(ambiguous)).status, 400);
});

test('handshake não contorna ambiente, configuração do segredo, HTTPS ou limite de corpo', async () => {
    assert.equal((await receive(withoutSecret(handshake()), { ...env, KIDMAIS_DEPLOY_ENV: 'production' })).status, 503);
    assert.equal((await receive(withoutSecret(handshake()), { ...env, GUPSHUP_WEBHOOK_SECRET: '' })).status, 503);
    assert.equal((await receive(new Request('http://staging.example/webhook', withoutSecret(handshake())))).status, 403);
    assert.equal((await receive(withoutSecret({ ...handshake(), extra: 'x'.repeat(MAX_BODY_BYTES) }))).status, 413);
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

for (const asynchronous of [false, true]) {
    test(`failed ${asynchronous ? 'assíncrono com gsId' : 'síncrono'}: code/reason sanitizados, hash e destino mascarado, ACK 204`, async () => {
        const input = { ...event('failed'), payload: {
            ...event('failed').payload,
            ...(asynchronous ? { gsId: 'synthetic-gupshup-id' } : {}),
            payload: { code: asynchronous ? '470' : 1008, reason: 'Recipient unavailable' },
        } };
        const original = JSON.stringify(input);
        const expectedHash = parseGupshupV2(event('failed'))?.messageIdHash;
        let logged: EventoSanitizado | undefined;
        const start = performance.now();
        const response = await receiveGupshupWebhook(request(input), env, (log) => { logged = log; });
        assert.equal(response.status, 204);
        assert.equal(await response.text(), '');
        assert.ok(performance.now() - start < 1000);
        assert.deepEqual(logged, {
            eventType: 'message-event', status: 'failed', timestamp: input.timestamp,
            messageIdHash: expectedHash, destinationMasked: '***00',
            failureCode: input.payload.payload.code, failureReason: 'Recipient unavailable',
        });
        assert.equal(JSON.stringify(input), original);
        for (const value of [input.payload.id, input.payload.destination, 'synthetic-gupshup-id', secret]) {
            assert.ok(!JSON.stringify(logged).includes(value));
        }
    });
}

test('failed: code/reason ausentes ou com tipos inesperados não impedem ACK 204', async () => {
    for (const details of [undefined, null, [], 'invalid', {}, { code: 0 }, { reason: 'Delivery failed' },
        { code: 'RATE_LIMIT', reason: '' }, { code: false, reason: false },
        { code: { password: secret }, reason: { password: secret } }, { code: ['1008'], reason: [secret] }]) {
        const input = { ...event('failed'), payload: { ...event('failed').payload, payload: details } };
        let logged: EventoSanitizado | undefined;
        assert.equal((await receiveGupshupWebhook(request(input), env, log => { logged = log; })).status, 204);
        assert.equal(logged?.status, 'failed');
        assert.equal(logged?.failureCode, details && typeof details === 'object' && 'code' in details
            && (details.code === 0 || details.code === 'RATE_LIMIT') ? details.code : undefined);
        assert.equal(logged?.failureReason, details && typeof details === 'object' && 'reason' in details
            && details.reason === 'Delivery failed' ? details.reason : undefined);
        assert.ok(!JSON.stringify(logged).includes(secret));
    }
});

test('failed: reason controla CRLF, controles Unicode e tamanho de 300 caracteres', () => {
    const input = event('failed');
    input.payload.payload = { code: 1008, reason: ' Delivery\r\nfailed\t\u0000\u001b\u0085\u2028\u2029\u202e injected entry ' };
    assert.equal(parseGupshupV2(input)?.failureReason, 'Delivery failed injected entry');
    input.payload.payload = { reason: 'Delivery unavailable. '.repeat(100) };
    const reason = parseGupshupV2(input)?.failureReason;
    assert.ok(reason && reason.length <= 300);
    assert.doesNotMatch(reason, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
});

test('failed: reason não reflete telefone, OTP, API key, headers, cookies ou payload serializado', async () => {
    const sensitive = [
        '5511999990000', '+55 (11) 99999-0000', '123456', 'sk_synthetic_private_key_not_real',
        `webhook secret: ${secret}`, 'Authorization: Bearer synthetic-bearer',
        'Cookie: session=synthetic-cookie', 'password=synthetic-password',
        '{"text":"PRIVATE BODY","otp":"654321"}',
        'https://private.example/?key=synthetic-key', 'private@example.test',
        'synthetic-message-id', 'synthetic-gupshup-id',
        'opaquecredentialwithmorethantwentyfourletters',
    ];
    for (const value of sensitive) {
        const input = { ...event('failed'), payload: {
            ...event('failed').payload, gsId: 'synthetic-gupshup-id',
            payload: { code: 1008, reason: `Delivery failed: ${value}` },
        } };
        let logged: EventoSanitizado | undefined;
        assert.equal((await receiveGupshupWebhook(request(input), env, log => { logged = log; })).status, 204);
        assert.equal(logged?.failureCode, 1008);
        assert.equal(logged?.destinationMasked, '***00');
        assert.ok(!JSON.stringify(logged).includes(value), 'Sensitive reason must be redacted');
        assert.ok(logged?.failureReason?.includes('[REDACTED]'));
    }
});

test('failed: segredo configurado arbitrário é removido inclusive atravessando o limite de corte', async () => {
    const arbitrarySecret = 'aa!bb@cc#dd$ee^ff&gg*hh(ii)jj-kk_ll';
    const input = event('failed');
    input.payload.payload = { reason: `${'Delivery failed. '.repeat(17)}${arbitrarySecret}` };
    let logged: EventoSanitizado | undefined;
    assert.equal((await receiveGupshupWebhook(request(input), { ...env, GUPSHUP_WEBHOOK_SECRET: arbitrarySecret },
        () => assert.fail('Must not log'))).status, 401);
    assert.equal((await receiveGupshupWebhook(request(input, { [SECRET_HEADER]: arbitrarySecret }),
        { ...env, GUPSHUP_WEBHOOK_SECRET: arbitrarySecret }, log => { logged = log; })).status, 204);
    assert.ok(logged?.failureReason?.endsWith('[REDACTED]'));
    assert.ok(!JSON.stringify(logged).includes('aa!bb'));
});

test('failed: code não é canal para credenciais ou texto arbitrário', async () => {
    for (const code of [secret, 'sk_test_key', '5511999990000', 5511999990000, NaN, Infinity,
        '1008\r\nINJECTED', 'x'.repeat(1000), 'token=private', 'SECRET_PRIVATE']) {
        const input = event('failed');
        input.payload.payload = { code, reason: 'Delivery failed' };
        let logged: EventoSanitizado | undefined;
        assert.equal((await receiveGupshupWebhook(request(input), env, log => { logged = log; })).status, 204);
        assert.equal(logged?.failureCode, undefined);
        assert.equal(logged?.failureReason, 'Delivery failed');
    }
});

test('failed: reason longa sem espaços mantém ACK rápido dentro do limite de payload', async () => {
    const input = event('failed');
    input.payload.payload = { code: 1008, reason: 'x'.repeat(60000) };
    let logged: EventoSanitizado | undefined;
    const start = performance.now();
    assert.equal((await receiveGupshupWebhook(request(input), env, log => { logged = log; })).status, 204);
    assert.ok(performance.now() - start < 1000);
    assert.equal(logged?.failureReason, '[REDACTED]');
});

test('diagnósticos vêm apenas de payload.payload de message-event/failed', () => {
    const details = { code: 1008, reason: 'Recipient unavailable' };
    for (const input of [
        { ...event('failed'), ...details },
        { ...event('failed'), payload: { ...event('failed').payload, ...details } },
        ...['enqueued', 'sent', 'delivered', 'read'].map(status => ({
            ...event(status), payload: { ...event(status).payload, payload: details },
        })),
        { ...event('failed'), type: 'message', payload: { ...event('failed').payload, payload: details } },
        { ...handshake(), payload: { ...handshake().payload, payload: details } },
    ]) {
        const parsed = parseGupshupV2(input);
        assert.ok(parsed);
        assert.equal(parsed.failureCode, undefined);
        assert.equal(parsed.failureReason, undefined);
    }
});

test('failed: campos arbitrários e corpo bruto nunca saem nos logs', async () => {
    const input = event('failed');
    input.payload.payload = { code: 1008, reason: 'Delivery failed', password: secret,
        text: 'PRIVATE BODY', otp: '654321', headers: { apikey: 'sk_private', cookie: 'private-cookie' } };
    let logged: EventoSanitizado | undefined;
    await receiveGupshupWebhook(request(input), env, (log) => { logged = log; });
    const output = JSON.stringify(logged);
    for (const value of ['PRIVATE BODY', '654321', 'sk_private', 'private-cookie', secret,
        input.payload.id, input.payload.destination, 'password', 'headers']) assert.ok(!output.includes(value));
    assert.ok(!output.includes(JSON.stringify(input.payload.payload)));
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
