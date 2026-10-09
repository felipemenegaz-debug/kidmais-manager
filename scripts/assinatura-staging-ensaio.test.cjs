/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {alvo,documento,cookies,prepararWebhook,validarRetomadaPrecheck}=require('./assinatura-staging-ensaio.cjs');
const valido={RENDER:'true',RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg',KIDMAIS_DEPLOY_ENV:'staging',ASAAS_AMBIENTE:'sandbox',
    ASSINATURA_PLANOS_ATIVOS:'true',DATABASE_SSL:'true',DATABASE_URL:'postgresql://synthetic@dpg-daidko3m8hqs73ce4jt0-a/kidmais_staging_1z91'};

test('quarta rodada tem IDs e diretório novos; flags ambíguas ou retomada são recusadas sem conexão',()=>{
    const args=['-e','console.log(JSON.stringify(require("./scripts/assinatura-staging-ensaio.cjs").fixture))','--','--rodada-4-autorizada'];
    const r=spawnSync(process.execPath,args,{encoding:'utf8',env:{}});
    assert.equal(r.status,0);
    const f=JSON.parse(r.stdout);
    assert.deepEqual(f,{empresa:'531f9c46-6026-4bfe-86aa-babce78b0cfd',usuario:'a3f1de69-7ed9-47aa-9864-4b8f7fca8c65',
        email:'assinatura-staging-a3f1de69@example.invalid',dir:'/opt/render/project/src/data/ensaio-assinatura-20261009-4'});
    for(const flags of [['--rodada-3-autorizada','--rodada-4-autorizada'],['--rodada-4-autorizada','--retomar-precheck-sem-recursos']]){
        const rejeitado=spawnSync(process.execPath,['scripts/assinatura-staging-ensaio.cjs',...flags],{encoding:'utf8',env:{}});
        assert.equal(rejeitado.status,1);assert.match(rejeitado.stderr,/RETOMADA_AGUARDANDO_AUTORIZACAO/);
    }
});

test('quinta rodada tem nova identidade e recusa seleção conjunta ou retomada antes de conectar',()=>{
    const r=spawnSync(process.execPath,['-e','console.log(JSON.stringify(require("./scripts/assinatura-staging-ensaio.cjs").fixture))','--','--rodada-5-autorizada'],{encoding:'utf8',env:{}});
    assert.equal(r.status,0);assert.deepEqual(JSON.parse(r.stdout),{
        empresa:'cbfbdb83-09d8-46d9-a1d4-9aeb6dc2b9dd',usuario:'cc401acf-f43c-4f86-b22e-7440ee394acd',
        email:'assinatura-staging-cc401acf@example.invalid',dir:'/opt/render/project/src/data/ensaio-assinatura-20261009-5'});
    for(const adicional of ['--rodada-3-autorizada','--rodada-4-autorizada','--retomar-precheck-sem-recursos']){
        const recusado=spawnSync(process.execPath,['scripts/assinatura-staging-ensaio.cjs','--rodada-5-autorizada',adicional],{encoding:'utf8',env:{}});
        assert.equal(recusado.status,1);assert.match(recusado.stderr,/RETOMADA_AGUARDANDO_AUTORIZACAO/);
    }
});
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
test('token omitido reutiliza metadata compatível sem criar webhook duplicado nem alterar o existente',async()=>{
    const cfg={webhookToken:'s'.repeat(32)}, r={empresa:'fixture'}, chamadas=[];
    const original={id:'hook_original',url:'https://kidmais-manager-staging.onrender.com/api/integracoes/asaas/webhook',enabled:true,
        interrupted:false,events:['PAYMENT_CONFIRMED','PAYMENT_RECEIVED']};
    await prepararWebhook(async(path,method='GET')=>{
        chamadas.push({path,method});
        if(path==='/webhooks?limit=100')return {totalCount:1,hasMore:false,data:[original]};
        if(path==='/webhooks/hook_original')return original;
        assert.fail('CHAMADA_NAO_PERMITIDA');
    },cfg,r,()=>{});
    assert.equal(r.webhookReutilizado,true);assert.equal(r.intencaoWebhook,undefined);assert.equal(r.tokenVerificadoNaConsulta,false);
    assert.deepEqual(chamadas.filter(c=>c.method!=='GET'),[]);
    assert.equal(original.authToken,undefined);assert.equal(original.enabled,true);
});
test('callback incompatível ou ambíguo interrompe antes de mutações',async()=>{
    const cfg={webhookToken:'s'.repeat(32)};
    const valido={id:'hook',url:'https://kidmais-manager-staging.onrender.com/api/integracoes/asaas/webhook',enabled:true,interrupted:false,events:['PAYMENT_CONFIRMED','PAYMENT_RECEIVED']};
    for(const w of [{...valido,enabled:false},{...valido,interrupted:true},{...valido,events:[]},{...valido,authToken:'outro-token'}, {...valido,url:'https://other.invalid'}]){
        await assert.rejects(prepararWebhook(async(path,method='GET')=>{assert.equal(method,'GET');
            return path==='/webhooks?limit=100'?{hasMore:false,data:[valido]}:w;},cfg,{empresa:'fixture'},()=>{}));
    }
    await assert.rejects(prepararWebhook(async(path,method='GET')=>{assert.equal(method,'GET');
        return path==='/webhooks?limit=100'?{hasMore:false,data:[valido,valido]}:valido;},cfg,{empresa:'fixture'},()=>{}));
});
test('retomada só aceita a rodada 3 interrompida antes de qualquer recurso, sem limpeza pendente',()=>{
    const r={empresa:'e4b274ca-3a51-40c5-bef6-39012a96cfbc',usuario:'067a7b63-7588-4897-b66b-a93f9fdbd56e',concluido:false,falha:{etapa:'WEBHOOK_PRECHECK',http:400},webhookRemovido:true};
    validarRetomadaPrecheck(r);
    for(const mudanca of [{empresa:'outro'},{usuario:'outro'},{concluido:true},{falha:{etapa:'CHECKOUT',http:400}},{falha:{etapa:'WEBHOOK_PRECHECK',http:500}},{webhookRemovido:false},
        ...['fixture','intencaoCheckout','clienteId','assinaturaId','pagamentoId','webhookId','intencaoConfirmacao','limpezaWebhookPendente','limpezaBancoPendente','limpezaAssinaturaPendente'].map(campo=>({[campo]:true}))])
        assert.throws(()=>validarRetomadaPrecheck({...r,...mudanca}));
});
test('callback com token conhecido compatível é reutilizado sem mutação',async()=>{
    const cfg={webhookToken:'s'.repeat(32)},r={empresa:'fixture'};
    const original={id:'hook_original',url:'https://kidmais-manager-staging.onrender.com/api/integracoes/asaas/webhook',enabled:true,
        interrupted:false,authToken:cfg.webhookToken,events:['PAYMENT_CONFIRMED','PAYMENT_RECEIVED']};
    await prepararWebhook(async(path,method='GET')=>{assert.equal(method,'GET');
        if(path==='/webhooks?limit=100')return {totalCount:1,hasMore:false,data:[original]};return original;
    },cfg,r,()=>{});assert.equal(r.webhookReutilizado,true);assert.equal(r.intencaoWebhook,undefined);
});
