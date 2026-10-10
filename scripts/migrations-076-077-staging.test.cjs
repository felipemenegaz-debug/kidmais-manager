/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline do aplicador de 076/077: sem banco nem rede.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const m = require('./migrations-076-077-staging.cjs');

const raiz = path.resolve(__dirname, '..');
const envStaging = () => ({RENDER:'true', RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV:'staging', ASAAS_AMBIENTE:'sandbox', DATABASE_SSL:'true',
    DATABASE_URL:'postgresql://usuario:sintetico@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'});

test('arquivos executados = arquivos revisados (hash fixado), na ordem precheck → migration → postcheck', () => {
    assert.deepEqual(m.ETAPAS.map(e => e[0]), ['precheck 076', 'migration 076', 'postcheck 076', 'precheck 077', 'migration 077', 'postcheck 077']);
    for (const [, arquivo, hash] of m.ETAPAS) assert.ok(m.lerRevisado(raiz, arquivo, hash).length > 100, arquivo);
    assert.throws(() => m.lerRevisado(raiz, m.ETAPAS[1][1], '0'.repeat(64)), /ARQUIVO_DIVERGENTE/);
});

test('só staging; produção, banco local e sslmode na URL são recusados; sem flag não executa', () => {
    assert.ok(m.alvo(envStaging()).connectionString.includes('kidmais_staging_1z91'));
    for (const v of [{RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg'}, {KIDMAIS_DEPLOY_ENV:'production'},
        {DATABASE_URL:'postgresql://u:s@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production'}, {DATABASE_URL:'postgresql://u:s@localhost:5432/kidmais_manager'},
        {DATABASE_URL:'postgresql://u:s@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91?sslmode=disable'}])
        assert.throws(() => m.alvo({...envStaging(), ...v}), undefined, JSON.stringify(v));
    assert.equal(m.autorizado([]), false); assert.equal(m.autorizado(['--aplicar-076-077-autorizado', '--x']), false);
    const r = spawnSync(process.execPath, [path.join(__dirname, 'migrations-076-077-staging.cjs')], {encoding:'utf8', env:{PATH:process.env.PATH}, timeout:20000});
    assert.equal(r.status, 1); assert.match(r.stderr, /AGUARDANDO_AUTORIZACAO_O3/);
});
