/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'); const assert=require('node:assert/strict');
const {janela,mensagem,executar}=require('./assinatura-aviso-email-staging.cjs');
const env={RENDER:'true',RENDER_SERVICE_ID:'crn-db493i142hec73ahmoe0',KIDMAIS_DEPLOY_ENV:'staging',ASAAS_AMBIENTE:'sandbox',
    EMAIL_PROVIDER:'resend',EMAIL_REMETENTE:'Kidmais Manager — Teste <onboarding@resend.dev>',
    ADMIN_AUTH_ORIGIN:'https://kidmais-manager-staging.onrender.com',RESEND_API_KEY:'re_fixture_sintetica'};
const args=['--enviar-teste','--inicio=2026-10-10T01:00:00.000Z','--fim=2026-10-10T01:04:00.000Z'];
const agora=new Date('2026-10-10T01:00:30.000Z');
test('recusa alvo/configuração divergentes antes da rede',async()=>{
    for(const alteracao of [{RENDER:'false'},{RENDER_SERVICE_ID:'srv-production'},{KIDMAIS_DEPLOY_ENV:'production'},
        {ASAAS_AMBIENTE:'production'},{EMAIL_PROVIDER:'arquivo'},{EMAIL_REMETENTE:'outro@example.invalid'},
        {ADMIN_AUTH_ORIGIN:'https://example.invalid'},{RESEND_API_KEY:''}])
        await assert.rejects(executar({...env,...alteracao},args,()=>assert.fail('rede'),agora));
});
test('sem argumentos e janelas longas/inválidas recusados',()=>{
    for(const a of [[],['--aplicar'],[...args,'--extra'],[args[0],args[1],'--fim=2026-10-10T01:05:00.000Z'],
        [args[0],args[1],args[1]],['--enviar-teste','--inicio=2026-02-30T01:00:00.000Z',args[2]]]) assert.throws(()=>janela(a));
});
test('fora da janela e fim exclusivo não chamam provedor',async()=>{
    for(const d of ['2026-10-10T00:59:59Z','2026-10-10T01:04:00Z','2026-10-12T01:00:00Z'])
        assert.equal((await executar(env,args,()=>assert.fail('rede'),new Date(d))).requisicoes,0);
});
test('payload imutável entre ticks, preço/data corretos e aviso de teste',async()=>{
    const m=await mensagem('2026-10-10T01:00:00.000Z'); assert.deepEqual(await mensagem('2026-10-10T01:00:00.000Z'),m);
    assert.match(m.texto,/08\/11\/2026/); assert.match(m.texto,/197,00/); assert.match(m.texto,/118,20/);
    assert.match(m.assunto,/^\[TESTE\]/); assert.match(m.texto,/Não é uma cobrança/);
    assert.equal(m.para,'felipemenegaz@gmail.com');assert.match(m.texto,/staging.onrender.com\/admin\/assinatura/);
});
test('dois POSTs idênticos comprovam replay por mesmo identificador e não expõem segredo no relatório',async()=>{
    const req=[];const fetcher=async(url,init)=>{req.push({url,init});return Response.json({id:'fixture-email-id'});};
    const r=await executar(env,args,fetcher,agora);assert.equal(r.resultado,'ACEITO_REPLAY_MESMO_ID');
    assert.equal(req.length,2); assert.equal(req[0].init.body,req[1].init.body);
    assert.equal(req[0].init.headers['Idempotency-Key'],req[1].init.headers['Idempotency-Key']);
    assert.equal(req[0].init.redirect,'error'); assert.equal(r.avisoNaTelaValidado,false);
    for(const s of [env.RESEND_API_KEY,'fixture-email-id','felipemenegaz'])assert.ok(!JSON.stringify(r).includes(s));
});
test('resposta incerta não faz retry automático; sem identificador interrompe antes do replay',async()=>{
    for(const resposta of [()=>{throw Error('segredo');},()=>Response.json({})]){
        let chamadas=0;await assert.rejects(executar(env,args,async()=>{chamadas++;return resposta();},agora));assert.equal(chamadas,1);
    }
});
test('replay com identificador diferente não declara sucesso',async()=>{
    let n=0;await assert.rejects(executar(env,args,async()=>Response.json({id:'id-'+(++n)}),agora),/REPLAY_DIVERGENTE/);
    assert.equal(n,2);
});
