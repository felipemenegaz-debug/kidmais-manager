/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {alvo,documento,cookies,prepararWebhook}=require('./assinatura-staging-ensaio.cjs');
const valido={RENDER:'true',RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg',KIDMAIS_DEPLOY_ENV:'staging',ASAAS_AMBIENTE:'sandbox',
    ASSINATURA_PLANOS_ATIVOS:'true',DATABASE_SSL:'true',DATABASE_URL:'postgresql://synthetic@dpg-daidko3m8hqs73ce4jt0-a/kidmais_staging_1z91'};
test('bloqueia produção, outro banco, host, serviço e flag antes de conectar',()=>{
    for(const troca of [{KIDMAIS_DEPLOY_ENV:'production'},{ASAAS_AMBIENTE:'production'},{RENDER_SERVICE_ID:'srv-other'},
        {DATABASE_URL:'postgresql://synthetic@localhost/kidmais_manager'},{ASSINATURA_PLANOS_ATIVOS:'false'},
        {DATABASE_URL:valido.DATABASE_URL+'?sslmode=disable'},{DATABASE_SSL:undefined}])assert.throws(()=>alvo({...valido,...troca}));
    assert.equal(alvo(valido).ssl.rejectUnauthorized,true);
    assert.equal(alvo({...valido,DATABASE_SSL_REJECT_UNAUTHORIZED:'false'}).ssl.minVersion,'TLSv1.2');
    assert.equal(alvo({...valido,DATABASE_SSL:'false'}).ssl,undefined);
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
test('com janela de staging de 1 dia, trial encerrado há 1 hora fica em leitura; 1 dia já bloqueia',async()=>{
    const {calcularAcessoComercial}=await import('../lib/assinatura/acesso.ts');
    const agora=Date.parse('2026-10-09T09:00:00Z');
    const fixture={situacao:'TESTE',testeFim:'2026-10-09T08:00:00Z',periodoAtualFim:null,emAtrasoDesde:null,encerradaEm:null};
    const prazos={regularizacaoDias:7,somenteLeituraDias:1};
    assert.equal(calcularAcessoComercial(fixture,[],agora,prazos).nivel,'SOMENTE_LEITURA');
    assert.equal(calcularAcessoComercial({...fixture,testeFim:'2026-10-08T09:00:00Z'},[],agora,prazos).nivel,'BLOQUEADO');
});
test('token omitido na consulta cria callback temporário conhecido e preserva o existente',async()=>{
    const cfg={webhookToken:'s'.repeat(32)}, r={empresa:'fixture'}, chamadas=[];
    const original={id:'hook_original',url:'https://kidmais-manager-staging.onrender.com/api/integracoes/asaas/webhook',enabled:true,
        interrupted:false,events:['PAYMENT_CONFIRMED','PAYMENT_RECEIVED']};
    let criado;
    await prepararWebhook(async(path,method='GET',body)=>{
        chamadas.push({path,method});
        if(path==='/webhooks?limit=100')return {totalCount:1,hasMore:false,data:[original]};
        if(path==='/webhooks/hook_original')return original;
        if(path==='/webhooks'&&method==='POST'){assert.equal(body.authToken,cfg.webhookToken);criado={...body,id:'hook_temporario'};return criado;}
        if(path==='/webhooks/hook_temporario')return {...criado,authToken:undefined};
        assert.fail('CHAMADA_NAO_PERMITIDA');
    },cfg,r,()=>{});
    assert.equal(r.webhookId,'hook_temporario');assert.equal(r.intencaoWebhook,true);
    assert.deepEqual(chamadas.filter(c=>c.method!=='GET'),[{path:'/webhooks',method:'POST'}]);
    assert.equal(original.authToken,undefined);assert.equal(original.enabled,true);
});
test('callback com token conhecido compatível é reutilizado sem mutação',async()=>{
    const cfg={webhookToken:'s'.repeat(32)},r={empresa:'fixture'};
    const original={id:'hook_original',url:'https://kidmais-manager-staging.onrender.com/api/integracoes/asaas/webhook',enabled:true,
        interrupted:false,authToken:cfg.webhookToken,events:['PAYMENT_CONFIRMED','PAYMENT_RECEIVED']};
    await prepararWebhook(async(path,method='GET')=>{assert.equal(method,'GET');
        if(path==='/webhooks?limit=100')return {totalCount:1,hasMore:false,data:[original]};return original;
    },cfg,r,()=>{});assert.equal(r.webhookReutilizado,true);assert.equal(r.intencaoWebhook,undefined);
});
