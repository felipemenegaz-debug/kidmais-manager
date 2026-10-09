/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {alvo,documento,cookies}=require('./assinatura-staging-ensaio.cjs');
const valido={RENDER:'true',RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg',KIDMAIS_DEPLOY_ENV:'staging',ASAAS_AMBIENTE:'sandbox',
    ASSINATURA_PLANOS_ATIVOS:'true',DATABASE_SSL:'true',DATABASE_URL:'postgresql://synthetic@dpg-daidko3m8hqs73ce4jt0-a/kidmais_staging_1z91'};
test('bloqueia produção, outro banco, host, serviço e flag antes de conectar',()=>{
    for(const troca of [{KIDMAIS_DEPLOY_ENV:'production'},{ASAAS_AMBIENTE:'production'},{RENDER_SERVICE_ID:'srv-other'},
        {DATABASE_URL:'postgresql://synthetic@localhost/kidmais_manager'},{ASSINATURA_PLANOS_ATIVOS:'false'},
        {DATABASE_URL:valido.DATABASE_URL+'?sslmode=disable'},{DATABASE_SSL:'false'}])assert.throws(()=>alvo({...valido,...troca}));
    assert.equal(alvo(valido).ssl.rejectUnauthorized,true);
    assert.equal(alvo({...valido,DATABASE_SSL_REJECT_UNAUTHORIZED:'false'}).ssl.minVersion,'TLSv1.2');
});
test('documento sintético tem dígitos verificadores válidos e nunca usa o buffet real',()=>{
    for(let i=0;i<20;i++){const d=documento();assert.match(d,/^\d{14}$/);assert.notEqual(d,'20119900000160');
        for(const [n,p] of [[12,[5,4,3,2,9,8,7,6,5,4,3,2]],[13,[6,5,4,3,2,9,8,7,6,5,4,3,2]]]){
            const resto=[...d.slice(0,n)].reduce((s,v,j)=>s+Number(v)*p[j],0)%11;assert.equal(Number(d[n]),resto<2?0:11-resto);}}
});
test('jar aplica rotação e remoção de cookies sem incluir atributos',()=>{
    const jar=new Map([['old','synthetic']]);cookies({getSetCookie:()=>['old=; Path=/; Max-Age=0','sid=one; HttpOnly; Secure','csrf=two; Path=/']},jar);
    assert.deepEqual([...jar],[['sid','one'],['csrf','two']]);cookies({getSetCookie:()=>['sid=rotated; HttpOnly']},jar);assert.equal(jar.get('sid'),'rotated');
});
