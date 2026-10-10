/* eslint-disable @typescript-eslint/no-require-imports */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {diagnosticar} = require('./assinatura-isencao-staging-diagnostico.cjs');
const env = { RENDER:'true', RENDER_SERVICE_ID:'crn-db493i142hec73ahmoe0', KIDMAIS_DEPLOY_ENV:'staging',
    ASAAS_AMBIENTE:'sandbox', KIDMAIS_RECONCILIAR_DATABASE_URL:'postgresql://fixture:sem-valor@dpg-daidko3m8hqs73ce4jt0-a/kidmais_staging_1z91',
    KIDMAIS_RECONCILIAR_ALVO:'kidmais_staging_1z91@dpg-daidko3m8hqs73ce4jt0-a:5432' };
function cliente(id = { db:'kidmais_staging_1z91',tls:true }, linhas = []) {
    const comandos = []; let fechado = false;
    return {comandos, fechado:()=>fechado, factory:()=>({on(){},async connect(){},async end(){fechado=true;},
        async query(sql){comandos.push(sql);return {rows:sql.includes('pg_stat_ssl')?[id]:sql.startsWith('-- PREPARADO')?linhas:[]};}})};
}
test('padrão offline não abre conexão', async()=>{
    assert.equal((await diagnosticar({},[],()=>{throw Error('Conexão proibida');})).bancoConsultado,false);
});
test('produção, outro serviço/banco ou argumento de escrita são recusados antes da conexão', async()=>{
    const proibido=()=>{throw Error('Factory não deveria ser chamada');};
    for(const patch of [{KIDMAIS_DEPLOY_ENV:'production'},{RENDER_SERVICE_ID:'srv-outro'},
        {KIDMAIS_RECONCILIAR_ALVO:'outro@host:5432'},{ASAAS_AMBIENTE:'production'}])
        await assert.rejects(diagnosticar({...env,...patch},['--consultar-staging'],proibido),/RECUSADO|Confirme o alvo/);
    await assert.rejects(diagnosticar(env,['--aplicar'],proibido),/ARGUMENTO_RECUSADO/);
});
test('identidade ou TLS divergente impedem consulta de dados e encerram conexão', async()=>{
    for(const id of [{db:'outro',tls:true},{db:'kidmais_staging_1z91',tls:false}]) {
        const c=cliente(id);await assert.rejects(diagnosticar(env,['--consultar-staging'],c.factory),/IDENTIDADE_BANCO_RECUSADA/);
        assert.ok(!c.comandos.some(sql=>sql.includes('20119900000160')));assert.equal(c.comandos.at(-1),'ROLLBACK');assert.ok(c.fechado());
    }
});
test('consulta usa transação somente leitura, documento exato e retorna apenas o alvo', async()=>{
    const row={banco:'kidmais_staging_1z91',empresa_id:'11111111-1111-4111-8111-111111111111'};
    const c=cliente(undefined,[row]),r=await diagnosticar(env,['--consultar-staging'],c.factory);
    assert.equal(c.comandos[0],'BEGIN READ ONLY');assert.equal(c.comandos.at(-1),'ROLLBACK');assert.ok(c.fechado());
    assert.match(c.comandos.find(sql=>sql.includes('20119900000160')),/WHERE c.documento_fiscal = '20119900000160'/);
    assert.equal(r.empresasEncontradas,1);assert.deepEqual(r.dados,[row]);assert.equal(r.isencaoConcedida,false);
    assert.ok(!c.comandos.some(sql=>/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER)\b/i.test(sql)));
});
test('zero resultados fica explícito; múltiplos resultados não permitem concluir identidade', async()=>{
    const c=cliente();assert.equal((await diagnosticar(env,['--consultar-staging'],c.factory)).empresasEncontradas,0);
    const d=cliente(undefined,[{},{}]);await assert.rejects(diagnosticar(env,['--consultar-staging'],d.factory),/RESULTADO_AMBIGUO/);assert.ok(d.fechado());
});
