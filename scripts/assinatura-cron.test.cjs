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
