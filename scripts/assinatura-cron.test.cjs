/* eslint-disable @typescript-eslint/no-require-imports */
const test=require('node:test'),assert=require('node:assert/strict');
const {planejar}=require('./assinatura-cron.cjs');
const env={KIDMAIS_DEPLOY_ENV:'staging',KIDMAIS_RECONCILIAR_MODO:'simular',ASAAS_AMBIENTE:'sandbox',
    KIDMAIS_RECONCILIAR_SCHEMA_VALIDADO:'074-075',KIDMAIS_RECONCILIAR_DATABASE_URL:'postgresql://fixture@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91',
    KIDMAIS_RECONCILIAR_ALVO:'kidmais_staging_1z91@dpg-daidko3m8hqs73ce4jt0-a:5432'};
test('cron inicia sem acesso ao banco e requer liberação explícita para simular/aplicar',()=>{
    assert.equal(planejar({KIDMAIS_DEPLOY_ENV:'staging',KIDMAIS_RECONCILIAR_MODO:'aguardando'}),null);
    assert.deepEqual(planejar(env),[]);
    assert.deepEqual(planejar({...env,KIDMAIS_RECONCILIAR_MODO:'aplicar'}),['--aplicar']);
    for(const alteracao of [{KIDMAIS_DEPLOY_ENV:'production'},{ASAAS_AMBIENTE:'producao'},{KIDMAIS_RECONCILIAR_SCHEMA_VALIDADO:''},{KIDMAIS_RECONCILIAR_MODO:undefined}])
        assert.throws(()=>planejar({...env,...alteracao}));
    assert.throws(()=>planejar({...env,KIDMAIS_RECONCILIAR_DATABASE_URL:'postgresql://fixture@localhost:5432/outro',KIDMAIS_RECONCILIAR_ALVO:'outro@localhost:5432'}),/ALVO_STAGING_RECUSADO/);
});

const prod={KIDMAIS_DEPLOY_ENV:'production',RENDER:'true',KIDMAIS_RECONCILIAR_MODO:'conferir',ASAAS_AMBIENTE:'producao',
    KIDMAIS_RECONCILIAR_SCHEMA_VALIDADO:'074-075',KIDMAIS_RECONCILIAR_DATABASE_URL:'postgresql://fixture@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production',
    KIDMAIS_RECONCILIAR_ALVO:'kidmais_production@dpg-dak750gae00c73fudmg0-a:5432'};
test('produção: conferência de pagamentos só em simulação, alvo e provedor de produção exatos',()=>{
    assert.deepEqual(planejar(prod),[],'conferir = simulação, sem --aplicar');
    assert.equal(planejar({...prod,KIDMAIS_RECONCILIAR_MODO:'aguardando'}),null);
    for(const alteracao of [{KIDMAIS_RECONCILIAR_MODO:'aplicar'},{KIDMAIS_RECONCILIAR_MODO:'simular'},{KIDMAIS_RECONCILIAR_MODO:undefined},
        {ASAAS_AMBIENTE:'sandbox'},{RENDER:undefined},{KIDMAIS_RECONCILIAR_SCHEMA_VALIDADO:''},
        {KIDMAIS_RECONCILIAR_DATABASE_URL:'postgresql://fixture@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91',KIDMAIS_RECONCILIAR_ALVO:'kidmais_staging_1z91@dpg-daidko3m8hqs73ce4jt0-a:5432'},
        {KIDMAIS_RECONCILIAR_DATABASE_URL:'postgresql://fixture@outro-host:5432/kidmais_production',KIDMAIS_RECONCILIAR_ALVO:'kidmais_production@outro-host:5432'}])
        assert.throws(()=>planejar({...prod,...alteracao}),undefined,JSON.stringify(alteracao));
});
