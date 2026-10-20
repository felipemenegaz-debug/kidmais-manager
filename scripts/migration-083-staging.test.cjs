/* eslint-disable @typescript-eslint/no-require-imports */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const m=require('./migration-083-staging.cjs'),helper=require('./conexao-staging.cjs');
const root=path.resolve(__dirname,'..');
const env={RENDER:'true',RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg',KIDMAIS_DEPLOY_ENV:'staging',ASAAS_AMBIENTE:'sandbox',ASSINATURA_PLANOS_ATIVOS:'true',DATABASE_SSL:'false',DATABASE_URL:'postgresql://user:password@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'};
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'hml-083-'));
function fake({m083=false,podeAlterar=true,fail=null,identity={db:'kidmais_staging_1z91',tls:false,servidor_privado:true}}={}) {
  const sent=[],sqls=new Map(m.ETAPAS.map(([name,file,hash])=>[m.lerRevisado(root,file,hash),name])); const state={m083,pode_alterar:podeAlterar};
  class Client {
    async connect(){}
    async end(){}
    async query(sql){
      if(sql===helper.SQL_IDENTIDADE)return {rows:[identity]};
      if(sql===m.SQL_SCHEMA)return {rows:[{...state}]};
      if(['BEGIN TRANSACTION READ ONLY','COMMIT','ROLLBACK'].includes(sql)){sent.push(sql);return {rows:[]};}
      const name=sqls.get(sql); sent.push(name??'OUTRO');
      if(name===fail)throw Error('falha simulada '+name);
      if(name==='migration 083')state.m083=true;
      return {rows:[]};
    }
  }
  return {Client,sent,state};
}
const execute=(dir,extra={})=>m.executar({env,dir,raiz:root,disco:()=>{},...extra});

test('arquivos 083 são executados pelos hashes revisados e a flag é isolada',()=>{
  assert.deepEqual(m.ETAPAS.map(x=>x[0]),['precheck 083','migration 083','postcheck 083']);
  for(const [,file,hash] of m.ETAPAS)assert.ok(m.lerRevisado(root,file,hash).length>100,file);
  assert.throws(()=>m.lerRevisado(root,m.ETAPAS[1][1],'0'.repeat(64)),/ARQUIVO_DIVERGENTE/);
  assert.equal(m.autorizado(['--aplicar-083-autorizado']),true);
  assert.equal(m.autorizado(['--aplicar-082-autorizado']),false);
  assert.equal(m.autorizado(['--aplicar-083-autorizado','--outro']),false);
  assert.equal(m.conferencia(['--conferir-083']),true);
  assert.equal(m.autorizado(['--conferir-083']),false);
});

test('alvo aceita exclusivamente o serviço e banco Render de staging',()=>{
  assert.match(m.alvo(env).connectionString,/kidmais_staging_1z91/);
  for(const change of [{RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg'},{KIDMAIS_DEPLOY_ENV:'production'},{DATABASE_URL:'postgresql://u:p@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production'},{DATABASE_URL:'postgresql://u:p@localhost:5432/kidmais_manager'},
    {DATABASE_URL:env.DATABASE_URL+'?host=localhost'},{DATABASE_URL:env.DATABASE_URL+'?port=5433'}])
    assert.throws(()=>m.alvo({...env,...change}));
  const secretUrl='postgresql://u:p@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91?password=SECRET_SENTINEL';
  assert.throws(()=>m.alvo({...env,DATABASE_URL:secretUrl}),error=>{
    assert.equal(error.message,'CONNECTION_QUERY_REJECTED');
    assert.equal(error.message.includes('SECRET_SENTINEL'),false);
    return true;
  });
});

test('schema ausente aplica precheck, migration e postcheck; schema aplicado só roda postcheck',async()=>{
  for(const applied of [false,true]){
    const dir=tmp();
    try{const f=fake({m083:applied}),r=await execute(dir,{Client:f.Client});assert.equal(r.resultado,'PASS');
      assert.deepEqual(r.etapas.map(x=>x.nome),applied?['postcheck 083']:['precheck 083','migration 083','postcheck 083']);
      assert.equal(r.schemaDepois.m083,true);
      await assert.rejects(execute(dir,{Client:fake().Client}),/TENTATIVA_ANTERIOR_REVISAR/);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
});

test('falha para sem repetir e guarda evidência sanitizada da etapa',async()=>{
  const dir=tmp();
  try{const f=fake({fail:'migration 083'}),r=await execute(dir,{Client:f.Client});assert.equal(r.resultado,'FALHA');
    assert.equal(r.falha.etapa,'migration 083');assert.deepEqual(f.sent.slice(-2),['migration 083','ROLLBACK']);
    const report=JSON.parse(fs.readFileSync(path.join(dir,'migration-083.json'),'utf8'));
    assert.equal(report.concluido,false);assert.equal(report.etapas[1].nome,'migration 083');
    await assert.rejects(execute(dir,{Client:fake().Client}),/TENTATIVA_ANTERIOR_REVISAR/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('conferência executa somente precheck em transação read-only e preserva o histórico',async()=>{
  const dir=tmp();
  try{const f=fake(),r=await m.conferir({env,dir,raiz:root,disco:()=>{},Client:f.Client});assert.equal(r.resultado,'CONFERIDO');
    assert.deepEqual(f.sent,['BEGIN TRANSACTION READ ONLY','precheck 083','COMMIT']);
    assert.equal(r.arquivo,'conferencia-083-1.json');
    assert.equal(r.schema.pode_alterar,true,'a conferência informa o privilégio de DDL');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('sem privilégio de DDL nas tabelas da 018 a aplicação para antes de qualquer escrita',async()=>{
  const dir=tmp();
  try{const f=fake({podeAlterar:false}),r=await execute(dir,{Client:f.Client});assert.equal(r.resultado,'FALHA');
    assert.match(r.falha.mensagem,/SEM_PRIVILEGIO_DDL/);
    assert.ok(!f.sent.includes('migration 083')&&!f.sent.includes('precheck 083'),'nenhum SQL da 083 foi enviado');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
