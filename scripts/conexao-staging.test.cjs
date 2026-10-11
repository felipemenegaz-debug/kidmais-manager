/* eslint-disable @typescript-eslint/no-require-imports */
// Conferência da conexão e do disco dos executores de staging: testes offline (sem banco, sem Render).
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('./conexao-staging.cjs');
const {alvo} = require('./migrations-076-077-staging.cjs');

const base = {RENDER:'true', RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV:'staging', ASAAS_AMBIENTE:'sandbox',
    DATABASE_URL:'postgresql://usuario:sintetico@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'};
const privado = {db:'kidmais_staging_1z91', tls:false, servidor_privado:true};
const comTls = {db:'kidmais_staging_1z91', tls:true, servidor_privado:false};

test('configuração privada de staging (DATABASE_SSL=false): aceita só sem TLS e em endereço privado', () => {
    const env = {...base, DATABASE_SSL:'false'};
    assert.equal(alvo(env).ssl, undefined, 'a trava existente já prevê este caso');
    assert.deepEqual(c.conferirIdentidade(privado, env), {banco:'kidmais_staging_1z91', tls:false, redePrivada:true});
    assert.throws(() => c.conferirIdentidade({...privado, servidor_privado:false}, env), /REDE_PRIVADA/);
    assert.throws(() => c.conferirIdentidade({...privado, servidor_privado:null}, env), /REDE_PRIVADA/);
    assert.throws(() => c.conferirIdentidade(comTls, env), /TLS/, 'divergência da configuração também para');
});

test('configuração com TLS: exige TLS e certificado verificado; nunca aceita conexão sem TLS', () => {
    const env = {...base, DATABASE_SSL:'true'};
    assert.equal(alvo(env).ssl.rejectUnauthorized, true);
    assert.equal(c.conferirIdentidade(comTls, env, '_S1').tls, true);
    assert.throws(() => c.conferirIdentidade(privado, env, '_S1'), /TLS_S1/);
    assert.throws(() => c.conferirIdentidade(comTls, {...env, DATABASE_SSL_REJECT_UNAUTHORIZED:'false'}), /CERTIFICADO_SEM_VERIFICACAO/);
});

test('banco divergente, configuração ausente ou desconhecida, linha vazia: recusa', () => {
    for (const env of [base, {...base, DATABASE_SSL:'1'}, {...base, DATABASE_SSL:'TRUE'}])
        assert.throws(() => c.conferirIdentidade(privado, env), /SSL_CONFIGURACAO_RECUSADA/);
    const env = {...base, DATABASE_SSL:'false'};
    assert.throws(() => c.conferirIdentidade({...privado, db:'kidmais_production'}, env), /BANCO/);
    assert.throws(() => c.conferirIdentidade({...privado, db:'kidmais_manager'}, env), /BANCO/);
    assert.throws(() => c.conferirIdentidade(undefined, env), /BANCO/);
});

test('alvos indevidos continuam recusados pela trava, inclusive com DATABASE_SSL=false', () => {
    for (const v of [{RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg'}, {KIDMAIS_DEPLOY_ENV:'production'}, {KIDMAIS_DEPLOY_ENV:undefined},
        {DATABASE_URL:'postgresql://u:s@dpg-daidko3m8hqs73ce4jt0-a.virginia-postgres.render.com:5432/kidmais_staging_1z91'},
        {DATABASE_URL:'postgresql://u:s@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production'},
        {DATABASE_URL:'postgresql://u:s@localhost:5432/kidmais_manager'},
        {DATABASE_URL:'postgresql://u:s@dpg-daidko3m8hqs73ce4jt0-a:6543/kidmais_staging_1z91'},
        {DATABASE_URL:'postgresql://u:s@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91?sslmode=disable'}])
        assert.throws(() => alvo({...base, DATABASE_SSL:'false', ...v}), undefined, JSON.stringify(v));
});

test('disco: só o ponto de montagem persistente; ausente ou no mesmo dispositivo do pai, recusa', () => {
    const stat = mapa => p => { if (!(p in mapa)) throw Object.assign(Error('ENOENT'), {code:'ENOENT'}); return {dev:mapa[p], isDirectory:() => true}; };
    assert.doesNotThrow(() => c.exigirDisco('/opt/render/project/src/data', stat({'/opt/render/project/src/data':2, '/opt/render/project/src':1})));
    assert.throws(() => c.exigirDisco('/opt/render/project/src/data', stat({'/opt/render/project/src/data':1, '/opt/render/project/src':1})), /DISCO_PERSISTENTE_AUSENTE/);
    assert.throws(() => c.exigirDisco('/opt/render/project/src/data', stat({'/opt/render/project/src':1})), /DISCO_PERSISTENTE_AUSENTE/);
    assert.throws(() => c.exigirDisco(), /DISCO_PERSISTENTE_AUSENTE/, 'fora do Render não há disco');
});
