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

test('produção: só o alvo exato com serviço e provedor de produção; TLS do serviço; kidmais_manager sempre recusado',()=>{
    const {validarAlvo,opcoesConexao,PRODUCAO}=require('./assinatura-reconciliar.cjs');
    const url=`postgresql://fixture@${PRODUCAO.host}:${PRODUCAO.port}/${PRODUCAO.database}`;
    const env={RENDER:'true',KIDMAIS_DEPLOY_ENV:'production',ASAAS_AMBIENTE:'producao',DATABASE_SSL:'true',
        KIDMAIS_RECONCILIAR_DATABASE_URL:url,KIDMAIS_RECONCILIAR_ALVO:`${PRODUCAO.database}@${PRODUCAO.host}:${PRODUCAO.port}`};
    const alvo=validarAlvo(env);
    assert.equal(alvo.producao,true);
    assert.deepEqual(opcoesConexao(alvo,env).ssl,{rejectUnauthorized:true,minVersion:'TLSv1.2'});
    assert.equal(opcoesConexao(alvo,{...env,DATABASE_SSL_REJECT_UNAUTHORIZED:'false'}).ssl.rejectUnauthorized,false,'espelha o serviço');
    assert.throws(()=>opcoesConexao(alvo,{...env,DATABASE_SSL:undefined}),/TLS_PRODUCAO_RECUSADO/);
    assert.throws(()=>opcoesConexao(alvo,{...env,KIDMAIS_RECONCILIAR_TLS:'render-interno-criptografado'}),/TLS_PRODUCAO_RECUSADO/);
    for(const mudanca of [{RENDER:undefined},{KIDMAIS_DEPLOY_ENV:'staging'},{ASAAS_AMBIENTE:'sandbox'},{ASAAS_AMBIENTE:undefined}])
        assert.throws(()=>validarAlvo({...env,...mudanca}),/conferência de produção exige/,JSON.stringify(mudanca));
    const outroHost={...env,KIDMAIS_RECONCILIAR_DATABASE_URL:url.replace(PRODUCAO.host,'outro'),KIDMAIS_RECONCILIAR_ALVO:`${PRODUCAO.database}@outro:${PRODUCAO.port}`};
    assert.throws(()=>validarAlvo(outroHost),/conferência de produção exige/);
    const real={...env,KIDMAIS_RECONCILIAR_DATABASE_URL:'postgresql://fixture@localhost:5432/kidmais_manager',KIDMAIS_RECONCILIAR_ALVO:'kidmais_manager@localhost:5432'};
    assert.throws(()=>validarAlvo(real),/proibido/);
    // staging continua sem a marca de produção
    const stg=validarAlvo({KIDMAIS_RECONCILIAR_DATABASE_URL:'postgresql://fixture@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91',KIDMAIS_RECONCILIAR_ALVO:'kidmais_staging_1z91@dpg-daidko3m8hqs73ce4jt0-a:5432'});
    assert.equal(stg.producao,false);
});

test('conferência: evento pendente ou empresa que mudaria = divergência; em produção sai 2; sem divergência sai 0',async()=>{
    const {executarCiclo,codigoDeSaida}=require('./assinatura-reconciliar.cjs');
    const ciclo=(eventos,empresas)=>executarCiclo({client:{query:async()=>{}},provedor:{},aplicar:false,banco:'sintetico',
        sinc:{eventosPendentes:async()=>eventos,empresasComProvedor:async()=>empresas.map((_,i)=>String(i)),processarEvento:async()=>({situacao:'PROCESSADO'}),
            sincronizarEmpresa:async(_c,i)=>empresas[Number(i)]}});
    const limpo=await ciclo([],[{resultado:'SINCRONIZADA',mudou:false}]);
    assert.equal(limpo.divergente,false); assert.equal(codigoDeSaida(limpo,true),0);
    const pago=await ciclo([],[{resultado:'SINCRONIZADA',mudou:true,antes:'TESTE',depois:'ATIVA'}]);
    assert.equal(pago.divergente,true); assert.equal(codigoDeSaida(pago,true),2); assert.equal(codigoDeSaida(pago,false),0,'staging inalterado');
    const evento=await ciclo(['e1'],[]);
    assert.equal(evento.divergente,true); assert.equal(codigoDeSaida(evento,true),2);
});

test('produção: --aplicar recusado antes de conectar',()=>{
    const fonte=require('node:fs').readFileSync(__dirname+'/assinatura-reconciliar.cjs','utf8');
    assert.match(fonte,/if \(alvo\.producao && aplicar\)\s+throw new Error\('Produção aceita só conferência/);
    assert.ok(fonte.indexOf('if (alvo.producao && aplicar)')<fonte.indexOf('await client.connect()'));
});

test('gratuidade da Kidmais na conferência: qualquer desvio é violação e reprova (saída 2) em qualquer ambiente',async()=>{
    const {conferirKidmais,codigoDeSaida}=require('./assinatura-reconciliar.cjs');
    const cliente=linha=>({query:async()=>({rows:[linha]})});
    const ok={empresas:1,ativas:1,assinaturas:0,contratacoes:0,fundadores:0,isencoes:0};
    assert.equal((await conferirKidmais(cliente(ok))).violada,false);
    assert.equal((await conferirKidmais(cliente({...ok,isencoes:1}))).isenta,true);
    for(const desvio of [{empresas:0,ativas:0},{empresas:2,ativas:2},{ativas:0},{assinaturas:1},{contratacoes:1},{fundadores:1}])
        assert.equal((await conferirKidmais(cliente({...ok,...desvio}))).violada,true,JSON.stringify(desvio));
    const limpo={incompleto:false,divergente:false,kidmais:{violada:false}};
    assert.equal(codigoDeSaida(limpo,true),0);
    assert.equal(codigoDeSaida({...limpo,kidmais:{violada:true}},true),2);
    assert.equal(codigoDeSaida({...limpo,kidmais:{violada:true}},false),2);
});
test('P1: empresa com leitura sem confirmação (404) deixa o ciclo incompleto (saída 2) e não conta como sem mudança',async()=>{
    const sinc={eventosPendentes:async()=>[],empresasComProvedor:async()=>['sem-confirmacao','ok'],processarEvento:async()=>({situacao:'PROCESSADO'}),
        sincronizarEmpresa:async(_c,id)=>id==='ok'?{resultado:'SINCRONIZADA',mudou:false}:{resultado:'SEM_CONFIRMACAO',motivo:'ASSINATURA_NAO_ENCONTRADA'}};
    const r=await executarCiclo({client:{query:async()=>{}},provedor:{},aplicar:true,banco:'sintetico',sinc});
    assert.deepEqual(r.empresas,{SEM_CONFIRMACAO:1,SEM_MUDANCA:1});
    assert.equal(r.incompleto,true);assert.equal(r.divergente,true);
});
