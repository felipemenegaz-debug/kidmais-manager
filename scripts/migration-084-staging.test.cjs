/* eslint-disable @typescript-eslint/no-require-imports */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const m=require('./migration-084-staging.cjs'),helper=require('./conexao-staging.cjs');
const root=path.resolve(__dirname,'..');
const env={RENDER:'true',RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg',KIDMAIS_DEPLOY_ENV:'staging',ASAAS_AMBIENTE:'sandbox',ASSINATURA_PLANOS_ATIVOS:'true',DATABASE_SSL:'false',DATABASE_URL:'postgresql://user:password@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'};
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'hml-084-'));
function fake({m084=false,podeAlterar=true,fail=null,mudarEstados=false,identity={db:'kidmais_staging_1z91',tls:false,servidor_privado:true}}={}) {
  const sent=[],sqls=new Map(m.ETAPAS.map(([name,file,hash])=>[m.lerRevisado(root,file,hash),name]));
  const state={m084,pode_alterar:podeAlterar,estados:{CONCLUIDA:9,INCERTA:1}};
  class Client {
    async connect(){}
    async end(){}
    async query(sql){
      if(sql===helper.SQL_IDENTIDADE)return {rows:[identity]};
      if(sql===m.SQL_SCHEMA)return {rows:[{...state,estados:{...state.estados}}]};
      if(['BEGIN TRANSACTION READ ONLY','COMMIT','ROLLBACK'].includes(sql)){sent.push(sql);return {rows:[]};}
      const name=sqls.get(sql); sent.push(name??'OUTRO');
      if(name===fail)throw Error('falha simulada '+name);
      if(name==='migration 084'){state.m084=true;if(mudarEstados)state.estados.INCERTA=0;}
      return {rows:[]};
    }
  }
  return {Client,sent,state};
}
const execute=(dir,extra={})=>m.executar({env,dir,raiz:root,disco:()=>{},...extra});

test('arquivos 084 são executados pelos hashes revisados e a flag é isolada',()=>{
  assert.deepEqual(m.ETAPAS.map(x=>x[0]),['precheck 084','migration 084','postcheck 084']);
  for(const [,file,hash] of m.ETAPAS)assert.ok(m.lerRevisado(root,file,hash).length>100,file);
  assert.throws(()=>m.lerRevisado(root,m.ETAPAS[1][1],'0'.repeat(64)),/ARQUIVO_DIVERGENTE/);
  assert.equal(m.autorizado(['--aplicar-084-autorizado']),true);
  assert.equal(m.autorizado(['--aplicar-083-autorizado']),false);
  assert.equal(m.autorizado(['--aplicar-084-autorizado','--outro']),false);
  assert.equal(m.conferencia(['--conferir-084']),true);
  assert.equal(m.autorizado(['--conferir-084']),false);
});

test('alvo aceita exclusivamente o serviço e banco Render de staging',()=>{
  assert.match(m.alvo(env).connectionString,/kidmais_staging_1z91/);
  for(const change of [{RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg'},{KIDMAIS_DEPLOY_ENV:'production'},{DATABASE_URL:'postgresql://u:p@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production'},{DATABASE_URL:'postgresql://u:p@localhost:5432/kidmais_manager'},
    {DATABASE_URL:env.DATABASE_URL+'?host=localhost'},{DATABASE_URL:env.DATABASE_URL+'?port=5433'}])
    assert.throws(()=>m.alvo({...env,...change}));
});

test('schema ausente aplica precheck, migration e postcheck; schema aplicado só roda postcheck; estados preservados',async()=>{
  for(const applied of [false,true]){
    const dir=tmp();
    try{const f=fake({m084:applied}),r=await execute(dir,{Client:f.Client});assert.equal(r.resultado,'PASS');
      assert.deepEqual(r.etapas.map(x=>x.nome),applied?['postcheck 084']:['precheck 084','migration 084','postcheck 084']);
      assert.equal(r.schemaDepois.m084,true); assert.deepEqual(r.schemaDepois.estados,r.schemaAntes.estados);
      await assert.rejects(execute(dir,{Client:fake().Client}),/TENTATIVA_ANTERIOR_REVISAR/);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
});

test('falha para sem repetir; estados alterados pela migration também falham e ficam registrados',async()=>{
  for(const opcoes of [{fail:'migration 084'},{mudarEstados:true}]){
    const dir=tmp();
    try{const f=fake(opcoes),r=await execute(dir,{Client:f.Client});assert.equal(r.resultado,'FALHA');
      if(opcoes.fail){assert.equal(r.falha.etapa,'migration 084');assert.deepEqual(f.sent.slice(-2),['migration 084','ROLLBACK']);}
      else assert.match(r.falha.mensagem,/ESTADOS_ALTERADOS/);
      const report=JSON.parse(fs.readFileSync(path.join(dir,'migration-084.json'),'utf8'));
      assert.equal(report.concluido,false);
      await assert.rejects(execute(dir,{Client:fake().Client}),/TENTATIVA_ANTERIOR_REVISAR/);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
});

test('conferência executa somente precheck em transação read-only',async()=>{
  const dir=tmp();
  try{const f=fake(),r=await m.conferir({env,dir,raiz:root,disco:()=>{},Client:f.Client});assert.equal(r.resultado,'CONFERIDO');
    assert.deepEqual(f.sent,['BEGIN TRANSACTION READ ONLY','precheck 084','COMMIT']);
    assert.equal(r.arquivo,'conferencia-084-1.json'); assert.equal(r.schema.pode_alterar,true);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('sem privilégio de DDL em convite_geracoes a aplicação para antes de qualquer escrita',async()=>{
  const dir=tmp();
  try{const f=fake({podeAlterar:false}),r=await execute(dir,{Client:f.Client});assert.equal(r.resultado,'FALHA');
    assert.match(r.falha.mensagem,/SEM_PRIVILEGIO_DDL/);
    assert.ok(!f.sent.includes('migration 084')&&!f.sent.includes('precheck 084'),'nenhum SQL da 084 foi enviado');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
