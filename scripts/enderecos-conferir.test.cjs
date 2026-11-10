/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const test = require('node:test');
const { argumentos, avaliar, conferir } = require('./enderecos-conferir.cjs');

const HASH = 'a'.repeat(64);
const A = 'https://manager.kidmaisfestas.com';
const N = 'https://iafest.demerzellabs.com.br';
const coerencia = { convites: true, site: true, agenda: true, midia: true, mcp: true };
const leitura = (extra = {}) => ({ modoEfetivo: 'ATIVA', codigo: 'OK', origemAtiva: 'N', painelNesteHost: false, toleranciaAtiva: true, tolerancia: 'VALIDA', coerencia, mcpRecursoSha256: HASH, ...extra });
const esperado = { antiga: A, nova: N, modo: 'ATIVA', mcpSha256: HASH, semNova: false, exigeTolerancia: true };

test('leitura certa não reprova', () => {
    assert.deepEqual(avaliar('A', leitura(), esperado), []);
    assert.deepEqual(avaliar('N', leitura({ painelNesteHost: true }), esperado), []);
});

test('cada divergência reprova com o seu código', () => {
    const casos = [
        [{ modoEfetivo: 'CONFIGURACAO_INVALIDA' }, 'A:MODO_DIVERGENTE'],
        [{ codigo: 'ADMIN_DIVERGENTE' }, 'A:CODIGO_ADMIN_DIVERGENTE'],
        [{ origemAtiva: 'A' }, 'A:ORIGEM_ATIVA_DIVERGENTE'],
        [{ painelNesteHost: true }, 'A:PAINEL_DIVERGENTE'],
        [{ painelNesteHost: null }, 'A:PAINEL_DIVERGENTE'],
        [{ tolerancia: 'INVALIDA' }, 'A:TOLERANCIA_INVALIDA'],
        [{ toleranciaAtiva: false }, 'A:TOLERANCIA_INATIVA'],
        [{ coerencia: null }, 'A:COERENCIA_AUSENTE'],
        [{ coerencia: { ...coerencia, midia: false } }, 'A:COERENCIA_MIDIA'],
        [{ coerencia: { ...coerencia, mcp: false } }, 'A:COERENCIA_MCP'],
        [{ coerencia: { ...coerencia, convites: false } }, 'A:COERENCIA_CONVITES'],
        [{ mcpRecursoSha256: 'b'.repeat(64) }, 'A:MCP_DIVERGENTE'],
        [{ mcpRecursoSha256: 'AUSENTE' }, 'A:MCP_DIVERGENTE'],
    ];
    for (const [mudanca, codigo] of casos) assert.ok(avaliar('A', leitura(mudanca), esperado).includes(codigo), codigo);
    assert.deepEqual(avaliar('A', null, esperado), ['A:SEM_RESPOSTA_VALIDA']);
    assert.deepEqual(avaliar('A', leitura({ toleranciaAtiva: false, tolerancia: 'VENCIDA' }), { ...esperado, exigeTolerancia: false }), []);
});

test('painel esperado segue o modo: A nos demais, N só em ATIVA', () => {
    const prep = { ...esperado, modo: 'PREPARACAO', exigeTolerancia: false };
    assert.deepEqual(avaliar('A', leitura({ modoEfetivo: 'PREPARACAO', origemAtiva: 'A', painelNesteHost: true }), prep), []);
    assert.ok(avaliar('N', leitura({ modoEfetivo: 'PREPARACAO', origemAtiva: 'A', painelNesteHost: true }), prep).includes('N:PAINEL_DIVERGENTE'));
});

test('DESLIGADO não exige coerência', () => {
    const d = { ...esperado, modo: 'DESLIGADO', exigeTolerancia: false, mcpSha256: 'AUSENTE' };
    assert.deepEqual(avaliar('A', leitura({ modoEfetivo: 'DESLIGADO', origemAtiva: 'INDETERMINADA', painelNesteHost: true, coerencia: null, mcpRecursoSha256: 'AUSENTE' }), d), []);
});

test('argumentos: origem exata, modo conhecido, hash formatado', () => {
    const base = ['--antiga', A, '--nova', N, '--modo', 'ATIVA', '--mcp-sha256', HASH];
    assert.equal(argumentos(base).modo, 'ATIVA');
    assert.equal(argumentos(['--antiga', A, '--sem-nova', '--modo', 'PREPARACAO', '--mcp-sha256', 'AUSENTE']).semNova, true);
    assert.throws(() => argumentos(['--antiga', `${A}/`, '--nova', N, '--modo', 'ATIVA', '--mcp-sha256', HASH]), /ORIGEM_INVALIDA/);
    assert.throws(() => argumentos(['--antiga', 'http://x.com', '--nova', N, '--modo', 'ATIVA', '--mcp-sha256', HASH]), /ORIGEM_INVALIDA/);
    assert.throws(() => argumentos(['--antiga', A, '--nova', N, '--modo', 'XPTO', '--mcp-sha256', HASH]), /MODO_INVALIDO/);
    assert.throws(() => argumentos(['--antiga', A, '--nova', N, '--modo', 'ATIVA', '--mcp-sha256', 'zz']), /MCP_SHA256_INVALIDO/);
});

test('conferir lê os dois hosts sem seguir redirecionamento; falha de rede reprova', async () => {
    const pedidos = [];
    const buscar = async (url, init) => { pedidos.push([url, init.redirect]); return new Response(JSON.stringify(leitura({ painelNesteHost: url.startsWith(N) }))); };
    assert.deepEqual(await conferir(esperado, buscar), []);
    assert.deepEqual(pedidos, [[`${A}/api/endereco-atual`, 'error'], [`${N}/api/endereco-atual`, 'error']]);
    assert.deepEqual(await conferir(esperado, async () => { throw Error('rede'); }), ['A:SEM_RESPOSTA_VALIDA', 'N:SEM_RESPOSTA_VALIDA']);
    assert.deepEqual(await conferir({ ...esperado, semNova: true }, async () => new Response('{}', { status: 500 })), ['A:SEM_RESPOSTA_VALIDA']);
});
