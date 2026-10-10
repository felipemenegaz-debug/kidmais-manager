/* eslint-disable @typescript-eslint/no-require-imports */
// Restauração da configuração anterior: testes offline (sem Render, sem rede).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const c = require('./configuracao-homologacao-staging.cjs');

test('registro guarda só presença e true/false; qualquer outro texto vira OUTRO (nunca o valor)', () => {
    assert.deepEqual(c.registrar({}), {COTACAO_PUBLICA_POR_EMPRESA:{presente:false, valor:null}, ASSINATURA_PLANOS_ATIVOS:{presente:false, valor:null}});
    assert.deepEqual(c.registrar({COTACAO_PUBLICA_POR_EMPRESA:'false', ASSINATURA_PLANOS_ATIVOS:'segredo-qualquer'}),
        {COTACAO_PUBLICA_POR_EMPRESA:{presente:true, valor:'false'}, ASSINATURA_PLANOS_ATIVOS:{presente:true, valor:'OUTRO'}});
});

test('conferência: restaurada só quando presença e valor voltam ao registro', () => {
    const ausentes = c.registrar({});
    assert.deepEqual(c.conferir(ausentes, {}), []);
    assert.equal(c.conferir(ausentes, {COTACAO_PUBLICA_POR_EMPRESA:'false'}).length, 1, 'false ≠ ausente');
    assert.equal(c.conferir(ausentes, {COTACAO_PUBLICA_POR_EMPRESA:'true', ASSINATURA_PLANOS_ATIVOS:'true'}).length, 2);
    const presentes = c.registrar({COTACAO_PUBLICA_POR_EMPRESA:'false', ASSINATURA_PLANOS_ATIVOS:'true'});
    assert.deepEqual(c.conferir(presentes, {COTACAO_PUBLICA_POR_EMPRESA:'false', ASSINATURA_PLANOS_ATIVOS:'true'}), []);
    assert.throws(() => c.conferir({X:{}}, {}), /REGISTRO_INVALIDO/);
});

test('plano de O5: remover no painel o que não existia; redefinir o valor anterior; parar se desconhecido', () => {
    assert.deepEqual(c.planoRestauracao(c.registrar({ASSINATURA_PLANOS_ATIVOS:'false'})), [
        {chave:'COTACAO_PUBLICA_POR_EMPRESA', acao:'REMOVER_NO_PAINEL'}, {chave:'ASSINATURA_PLANOS_ATIVOS', acao:'DEFINIR', valor:'false'}]);
    assert.equal(c.planoRestauracao(c.registrar({COTACAO_PUBLICA_POR_EMPRESA:'x'}))[0].acao, 'PARAR_VALOR_DESCONHECIDO');
});

test('comando de uma linha (antes de O1) grava exatamente o mesmo registro e não sobrescreve', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hml-config-'));
    try {
        const linha = c.COMANDO_REGISTRO.split(' && ')[1];
        const codigo = linha.slice("node -e '".length, -1);
        fs.mkdirSync(path.join(dir, 'data', 'homologacao-planos-cotacao-20261010'), {recursive:true});
        const env = {PATH:process.env.PATH, COTACAO_PUBLICA_POR_EMPRESA:'false'};
        const r1 = spawnSync(process.execPath, ['-e', codigo], {cwd:dir, env, encoding:'utf8'});
        assert.equal(r1.status, 0, r1.stderr);
        const gravado = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'homologacao-planos-cotacao-20261010', c.ARQUIVO), 'utf8'));
        assert.deepEqual(gravado, c.registrar(env));
        assert.notEqual(spawnSync(process.execPath, ['-e', codigo], {cwd:dir, env, encoding:'utf8'}).status, 0, 'segunda gravação recusada (wx)');
    } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('conferência só no web staging', () => {
    assert.throws(() => c.alvo({RENDER:'true', RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV:'production'}));
    const r = spawnSync(process.execPath, [path.join(__dirname, 'configuracao-homologacao-staging.cjs'), '--conferir-restauracao'], {encoding:'utf8', env:{PATH:process.env.PATH}});
    assert.equal(r.status, 1);
});
