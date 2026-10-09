/* eslint-disable @typescript-eslint/no-require-imports */
const test=require('node:test'),assert=require('node:assert/strict');
const {executarCiclo}=require('./assinatura-reconciliar.cjs');
test('ciclo sinaliza falha sem abandonar os próximos itens e faz rollback por item',async()=>{
    const comandos=[],visitados=[];
    const client={query:async sql=>{comandos.push(sql);}};
    const sinc={eventosPendentes:async()=>['erro','falhou','ok'],empresasComProvedor:async()=>['recusada'],
        processarEvento:async(_c,id)=>{visitados.push(id);if(id==='erro')throw Error('segredo-nao-deve-sair');return{situacao:id==='falhou'?'FALHOU':'PROCESSADO'};},
        sincronizarEmpresa:async()=>({resultado:'RECUSADA'})};
    const r=await executarCiclo({client,provedor:{},aplicar:true,banco:'sintetico',sinc});
    assert.equal(r.incompleto,true);assert.deepEqual(visitados,['erro','falhou','ok']);
    assert.deepEqual(r.eventos,{ERRO_Error:1,FALHOU:1,PROCESSADO:1});
    assert.equal(comandos.filter(s=>s==='ROLLBACK').length,1);assert.equal(comandos.filter(s=>s==='COMMIT').length,3);
    assert.ok(!JSON.stringify(r).includes('segredo'));
});
test('simulação não confirma transações; ciclo sem falhas é completo',async()=>{
    const comandos=[];
    const sinc={eventosPendentes:async()=>['ok'],empresasComProvedor:async()=>[],processarEvento:async()=>({situacao:'PROCESSADO'})};
    const r=await executarCiclo({client:{query:async s=>comandos.push(s)},provedor:{},aplicar:false,banco:'sintetico',sinc});
    assert.equal(r.incompleto,false);assert.deepEqual(comandos,['BEGIN','ROLLBACK']);
});

test('URL do banco não pode desabilitar verificação TLS remota',()=>{
    const {opcoesConexao}=require('./assinatura-reconciliar.cjs');
    const alvo={connectionString:'postgresql://fixture@example.test/staging?sslmode=require',local:false};
    const o=opcoesConexao(alvo);
    assert.equal(o.ssl.rejectUnauthorized,true);
    assert.equal(new URL(o.connectionString).searchParams.has('sslmode'),false);
    assert.throws(()=>opcoesConexao({...alvo,connectionString:alvo.connectionString.replace('require','no-verify')}),/TLS_MODO_RECUSADO/);
    assert.equal(opcoesConexao(alvo,{KIDMAIS_RECONCILIAR_CA_PEM:'certificado-fixture'}).ssl.ca,'certificado-fixture');
    const tentativa=opcoesConexao({...alvo,connectionString:alvo.connectionString+'&ssl=false&uselibpqcompat=true'});
    assert.equal(tentativa.ssl.rejectUnauthorized,true);
    assert.equal(new URL(tentativa.connectionString).searchParams.has('ssl'),false);
});

test('TLS interno exige opt-in, identidade do cron Render e alvo literal exato',()=>{
    const {validarAlvo,opcoesConexao}=require('./assinatura-reconciliar.cjs');
    const env={RENDER:'true',RENDER_SERVICE_ID:'crn-db493i142hec73ahmoe0',KIDMAIS_DEPLOY_ENV:'staging',ASAAS_AMBIENTE:'sandbox',
        KIDMAIS_RECONCILIAR_TLS:'render-interno-criptografado',
        KIDMAIS_RECONCILIAR_DATABASE_URL:'postgresql://fixture@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91?sslmode=require',
        KIDMAIS_RECONCILIAR_ALVO:'kidmais_staging_1z91@dpg-daidko3m8hqs73ce4jt0-a:5432'};
    const alvo=validarAlvo(env);
    assert.deepEqual(opcoesConexao(alvo,env).ssl,{rejectUnauthorized:false,minVersion:'TLSv1.2'});
    assert.equal(opcoesConexao(alvo,{...env,KIDMAIS_RECONCILIAR_TLS:undefined}).ssl.rejectUnauthorized,true);
    for(const mudanca of [{RENDER:undefined},{RENDER_SERVICE_ID:'outro'},{KIDMAIS_DEPLOY_ENV:'production'},{ASAAS_AMBIENTE:'producao'}])
        assert.throws(()=>opcoesConexao(alvo,{...env,...mudanca}),/TLS_REDE_PRIVADA_RECUSADA/);
    for(const [host,db,porta] of [['example.test','kidmais_staging_1z91',5432],['dpg-daidko3m8hqs73ce4jt0-a','outro',5432],['dpg-daidko3m8hqs73ce4jt0-a','kidmais_staging_1z91',6432]]) {
        const alterado={...env,KIDMAIS_RECONCILIAR_DATABASE_URL:`postgresql://fixture@${host}:${porta}/${db}`,KIDMAIS_RECONCILIAR_ALVO:`${db}@${host}:${porta}`};
        assert.throws(()=>opcoesConexao(validarAlvo(alterado),alterado),/TLS_REDE_PRIVADA_RECUSADA/);
    }
    assert.throws(()=>opcoesConexao({...alvo,connectionString:'postgresql://fixture@example.test/outro'},env),/TLS_REDE_PRIVADA_RECUSADA/);
    assert.throws(()=>opcoesConexao(alvo,{...env,KIDMAIS_RECONCILIAR_TLS:'no-verify'}),/TLS_POLITICA_RECUSADA/);
});
