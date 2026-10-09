/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test'), assert = require('node:assert/strict');
const {verificar, REFERENCIA, REFERENCIA_QUARTA} = require('./assinatura-staging-preflight.cjs');
const env = {RENDER:'true', RENDER_SERVICE_ID:'crn-db493i142hec73ahmoe0', KIDMAIS_DEPLOY_ENV:'staging',
    ASAAS_AMBIENTE:'sandbox', ASAAS_API_KEY:'$aact_hmlg_fixture', ASAAS_WEBHOOK_TOKEN:'x'.repeat(32)};
test('diagnóstico só faz GET de referência sintética em sandbox e não devolve secrets ou dados', async () => {
    let chamadas = 0;
    const r = await verificar(env, async (url, init) => {
        chamadas++;
        assert.equal(new URL(url).searchParams.get('externalReference'), REFERENCIA);
        assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
        return new Response(JSON.stringify({data:[{id:'cus_fixture',name:'DADO_NAO_EXIBIR'}]}),{status:200});
    });
    assert.equal(chamadas,1); assert.equal(r.asaas,'AUTENTICACAO_APROVADA'); assert.equal(r.bancoAcessado,false);
    assert.ok(!JSON.stringify(r).includes('DADO_NAO_EXIBIR')); assert.ok(!JSON.stringify(r).includes(env.ASAAS_API_KEY));
});
test('produção, serviço diferente e configuração inválida são recusados antes de qualquer chamada', async () => {
    let chamadas=0;
    for (const alteracao of [{KIDMAIS_DEPLOY_ENV:'production'},{RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg'},
        {RENDER:undefined},{ASAAS_AMBIENTE:'producao'},{ASAAS_API_KEY:'$aact_prod_fixture'}])
        await assert.rejects(verificar({...env,...alteracao},async()=>{chamadas++;}),/RECUSAD/);
    assert.equal(chamadas,0);
});
test('401 de autenticação falha o diagnóstico com código sanitizado', async () => {
    await assert.rejects(verificar(env,async()=>new Response(JSON.stringify({errors:[{description:'NAO_LOGAR'}]}),{status:401})),
        e => e.status===401 && !e.message.includes('NAO_LOGAR') && !e.message.includes(env.ASAAS_API_KEY));
});

test('quarta rodada só consulta sua referência reservada; referência arbitrária é recusada', async () => {
    let chamadas = 0;
    const req = async (url, init) => {
        chamadas++;
        assert.equal(new URL(url).searchParams.get('externalReference'), REFERENCIA_QUARTA);
        assert.equal(init.method, 'GET');
        return new Response(JSON.stringify({data:[]}), {status:200});
    };
    assert.equal((await verificar(env, req, REFERENCIA_QUARTA)).clienteReferenciaEncontrado, false);
    await assert.rejects(verificar(env, req, 'empresa-real'), /REFERENCIA_RECUSADA/);
    assert.equal(chamadas, 1);
});
