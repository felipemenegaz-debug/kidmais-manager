import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { diagnosticarOrigemRequest, linhaDiagnosticoRecusaOrigemAdmin, origemMutacaoValida, origemRequestValida, type AmbientePoliticaAdmin } from './admin-origin.ts';

const origemPublica = 'https://kidmais-manager-staging.onrender.com';
const envRender = {
    ADMIN_AUTH_ORIGIN: origemPublica,
    KIDMAIS_DEPLOY_ENV: 'staging',
    NODE_ENV: 'production',
    RENDER: 'true',
};

function requestDireta(url: string, headers: Record<string, string> = {}) {
    const request = new Request(url, { headers });
    return Object.assign(request, { nextUrl: new URL(request.url) });
}

function requestRender(headers: Record<string, string> = {}) {
    return requestDireta('https://localhost:10000/api/admin/autenticacao', headers);
}

function headersRender(overrides: Record<string, string> = {}): Record<string, string> {
    return {
        host: 'kidmais-manager-staging.onrender.com',
        'x-forwarded-host': 'kidmais-manager-staging.onrender.com',
        'x-forwarded-proto': 'https',
        ...overrides,
    };
}

function origemRenderValida(headers: Record<string, string>, env: AmbientePoliticaAdmin = envRender, configurada = origemPublica) {
    return origemRequestValida(requestRender(headers), new URL(configurada), env);
}

test('local sem proxy preserva comparação direta de nextUrl.origin', () => {
    assert.equal(
        origemRequestValida(
            requestDireta('http://localhost:3000/api/admin/autenticacao'),
            new URL('http://localhost:3000'),
            { ADMIN_AUTH_ORIGIN: 'http://localhost:3000', NODE_ENV: 'development' },
        ),
        true,
    );
    assert.equal(
        origemRequestValida(
            requestDireta('http://localhost:3001/api/admin/autenticacao'),
            new URL('http://localhost:3000'),
            { ADMIN_AUTH_ORIGIN: 'http://localhost:3000', NODE_ENV: 'development' },
        ),
        false,
    );
});

test('Render staging aceita proxy válido com Host e X-Forwarded-Host corretos', () => {
    assert.equal(origemRenderValida(headersRender()), true);
});

test('Render staging aceita Host correto quando X-Forwarded-Host não existe', () => {
    const headers = headersRender();
    delete headers['x-forwarded-host'];
    assert.equal(origemRenderValida(headers), true);
});

test('Render staging aceita X-Forwarded-Host correto quando Host não existe', () => {
    const headers = headersRender();
    delete headers.host;
    assert.equal(origemRenderValida(headers), true);
});

test('Render staging recusa Host forjado mesmo com forwarded-host correto', () => {
    assert.equal(origemRenderValida(headersRender({ host: 'evil.example' })), false);
});

test('Render staging recusa X-Forwarded-Host diferente', () => {
    assert.equal(origemRenderValida(headersRender({ 'x-forwarded-host': 'evil.example' })), false);
});

test('Render staging recusa X-Forwarded-Host múltiplo', () => {
    assert.equal(origemRenderValida(headersRender({ 'x-forwarded-host': 'kidmais-manager-staging.onrender.com, evil.example' })), false);
});

test('Render staging recusa protocolo HTTP', () => {
    assert.equal(origemRenderValida(headersRender({ 'x-forwarded-proto': 'http' })), false);
});

test('Render staging recusa X-Forwarded-Proto múltiplo', () => {
    assert.equal(origemRenderValida(headersRender({ 'x-forwarded-proto': 'https,http' })), false);
});

test('Render staging recusa headers proxy ausentes', () => {
    assert.equal(origemRenderValida({}), false);
    assert.equal(origemRenderValida({ host: 'kidmais-manager-staging.onrender.com' }), false);
});

test('diagnóstico identifica precisamente as recusas proxy do staging', () => {
    const diagnosticar = (headers: Record<string, string>, configurada = origemPublica) =>
        diagnosticarOrigemRequest(requestRender(headers), new URL(configurada), envRender);

    assert.equal(diagnosticar(headersRender(), 'http://kidmais-manager-staging.onrender.com').codigo, 'ADMIN_ORIGIN_INVALID');
    assert.equal(diagnosticar(headersRender({ 'x-forwarded-proto': '' })).codigo, 'FORWARDED_PROTO_INVALID');
    assert.equal(diagnosticar(headersRender({ 'x-forwarded-proto': 'https,http' })).codigo, 'MULTIPLE_FORWARDED_PROTOS');
    assert.equal(diagnosticar({ host: origemPublica.replace('https://', '') }).codigo, 'FORWARDED_PROTO_MISSING');
    assert.equal(diagnosticar({ 'x-forwarded-proto': 'https' }).codigo, 'HOST_MISSING');
    assert.equal(diagnosticar(headersRender({ host: 'evil.example' })).codigo, 'HOST_MISMATCH');
    assert.equal(diagnosticar(headersRender({ host: 'kidmais-manager-staging.onrender.com, evil.example' })).codigo, 'MULTIPLE_HOSTS');
    assert.equal(diagnosticar(headersRender({ 'x-forwarded-host': 'evil.example' })).codigo, 'FORWARDED_HOST_MISMATCH');
    assert.equal(diagnosticar(headersRender({ 'x-forwarded-host': 'kidmais-manager-staging.onrender.com, evil.example' })).codigo, 'MULTIPLE_FORWARDED_HOSTS');
});

test('log temporário expõe somente diagnóstico sanitizado no Render staging recusado', () => {
    const diagnostico = diagnosticarOrigemRequest(
        requestRender(headersRender({ host: 'proxy-interno.render.com' })),
        new URL(origemPublica),
        envRender,
    );
    const linha = linhaDiagnosticoRecusaOrigemAdmin(diagnostico);

    assert.ok(linha);
    assert.match(linha, /^\[Kidmais Admin Origin\] /);
    assert.match(linha, /"renderReconhecido":true/);
    assert.match(linha, /"stagingReconhecido":true/);
    assert.match(linha, /"adminOriginValida":true/);
    assert.match(linha, /"hostPresente":true/);
    assert.match(linha, /"forwardedHostPresente":true/);
    assert.match(linha, /"forwardedProtoPresente":true/);
    assert.match(linha, /"host":"proxy-interno\.render\.com"/);
    assert.match(linha, /"forwardedHost":"kidmais-manager-staging\.onrender\.com"/);
    assert.match(linha, /"forwardedProto":"https"/);
    assert.match(linha, /"codigo":"HOST_MISMATCH"/);
    assert.doesNotMatch(linha, /cookie|authorization|csrf|database_url|secret|password/i);
});

test('diagnóstico temporário não gera log fora do Render staging nem em requisição aceita', () => {
    const aceita = diagnosticarOrigemRequest(requestRender(headersRender()), new URL(origemPublica), envRender);
    const foraDoRender = diagnosticarOrigemRequest(
        requestRender(headersRender()),
        new URL(origemPublica),
        { ...envRender, RENDER: undefined },
    );
    const foraDoStaging = diagnosticarOrigemRequest(
        requestRender(headersRender()),
        new URL(origemPublica),
        { ...envRender, KIDMAIS_DEPLOY_ENV: 'production' },
    );

    assert.equal(linhaDiagnosticoRecusaOrigemAdmin(aceita), null);
    assert.equal(linhaDiagnosticoRecusaOrigemAdmin(foraDoRender), null);
    assert.equal(linhaDiagnosticoRecusaOrigemAdmin(foraDoStaging), null);
});

test('Render staging recusa ADMIN_AUTH_ORIGIN HTTP ou localhost', () => {
    assert.equal(origemRenderValida(headersRender(), envRender, 'http://kidmais-manager-staging.onrender.com'), false);
    assert.equal(origemRenderValida(headersRender({ host: 'localhost', 'x-forwarded-host': 'localhost' }), envRender, 'https://localhost'), false);
});

test('sem RENDER a política proxy não é ativada', () => {
    assert.equal(origemRenderValida(headersRender(), { ...envRender, RENDER: undefined }), false);
});

test('fora de staging a política proxy não é ativada', () => {
    assert.equal(origemRenderValida(headersRender(), { ...envRender, KIDMAIS_DEPLOY_ENV: 'production' }), false);
});

test('POST exige Origin exatamente igual ao configurado', () => {
    assert.equal(origemMutacaoValida(requestRender(headersRender({ origin: 'https://evil.example' })), origemPublica), false);
    assert.equal(origemMutacaoValida(requestRender(headersRender({ origin: origemPublica })), origemPublica), true);
});

test('verificações CSRF permanecem obrigatórias nas rotas administrativas', () => {
    const route = readFileSync('app/api/admin/autenticacao/route.ts', 'utf8');
    const guard = readFileSync('lib/http/admin-crm-api.ts', 'utf8');
    assert.match(guard, /throw authError\('Use a origem administrativa segura configurada\.', 403\)/);
    assert.match(guard, /throw authError\('Origem da requisição recusada\.', 403\)/);
    assert.match(route, /request\.cookies\.get\(policy\.csrfCookie\)/);
    assert.match(route, /request\.headers\.get\('x-csrf-token'\)/);
    assert.match(guard, /request\.headers\.get\('x-csrf-token'\)/);
    assert.match(guard, /session\.csrf_hash/);
});
