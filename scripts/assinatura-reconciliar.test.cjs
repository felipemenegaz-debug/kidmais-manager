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
});
