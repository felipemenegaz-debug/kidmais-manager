/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador 085/086 com cliente SIMULADO: prova a lógica (modos, alvo, ordem, recusas, registro, retomada, sigilo).
// NÃO prova SQL real, locks do PostgreSQL nem transações: isso fica para a rodada PostgreSQL autorizada (OBS-2).
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const m=require('./migration-085-086-staging.cjs'),helper=require('./conexao-staging.cjs');
const root=path.resolve(__dirname,'..');
const SENHA='senha-ficticia-do-teste';
const env={RENDER:'true',RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg',KIDMAIS_DEPLOY_ENV:'staging',ASAAS_AMBIENTE:'sandbox',ASSINATURA_PLANOS_ATIVOS:'true',DATABASE_SSL:'false',DATABASE_URL:`postgresql://user:${SENHA}@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91`};
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'hml-085-086-'));
const PRE_OK={'precheck 085':{tem_empresas:true,tem_estabelecimentos:true,tem_memberships:true,clientes_tem_empresa_054:true,fechamentos_tem_unidade_062:true,marketing_ausente:true},
  'precheck 086':{tem_085:true,tem_funcao_append_only:true,automacoes_ausentes:true}};

/** Banco simulado: estado do schema por contagens, privilégios e agregados; reconhece cada SQL revisado pelo conteúdo. */
function fake({m083=true,m084=true,s085='ausente',s086='ausente',criar=true,referenciar=true,gatilho=true,trava=true,fail=null,precheckFalso=null,
  mudarConvites=false,parcialDepois=null,identity={db:'kidmais_staging_1z91',tls:false,servidor_privado:true}}={}) {
  const sent=[],sqls=new Map(m.ETAPAS.map(([name,file,hash])=>[m.lerRevisado(root,file,hash),name]));
  const st={m083,m084,s085,s086,convites:{CONCLUIDA:6,INCERTA:1},whatsapp:2};
  const conta=(s,total)=>s==='completa'?{t:total,f:3}:s==='parcial'?{t:2,f:0}:{t:0,f:0};
  let conectados=0,encerrados=0;
  class Client {
    constructor(opts){this.opts=opts;}
    async connect(){conectados++;}
    async end(){encerrados++;}
    async query(sql){
      if(sql===helper.SQL_IDENTIDADE){sent.push('identidade');return {rows:[identity]};}
      if(sql===m.SQL_TRAVA){sent.push('trava');return {rows:[{trava}]};}
      if(sql===m.SQL_SOLTAR){sent.push('soltar');return {rows:[{solta:true}]};}
      if(sql===m.SQL_ESTADO){sent.push('estado');const a=conta(st.s085,m.TABELAS_085.length),b=conta(st.s086,m.TABELAS_086.length);
        return {rows:[{m083:st.m083,m084:st.m084,tabelas_085:a.t,funcoes_085:a.f,tabelas_086:b.t,funcoes_086:b.f,gatilho_086_clientes:st.s086==='completa',
          pode_criar:criar,pode_referenciar:referenciar,pode_gatilho_clientes:gatilho,convites_estados:{...st.convites},whatsapp_conexoes:st.whatsapp}]};}
      if(['BEGIN TRANSACTION READ ONLY','COMMIT','ROLLBACK'].includes(sql)){sent.push(sql);return {rows:[]};}
      const name=sqls.get(sql); sent.push(name??'OUTRO');
      if(!name)throw Error('SQL não revisado enviado');
      if(name===fail)throw Error('falha simulada '+name);
      if(name.startsWith('precheck')){const row={...PRE_OK[name]};if(precheckFalso===name)row[Object.keys(row).at(-1)]=false;return [{rows:[]},{rows:[row]},{rows:[]}];}
      if(name==='migration 085'){st.s085=parcialDepois==='085'?'parcial':'completa';if(mudarConvites)st.convites.INCERTA=0;}
      if(name==='migration 086')st.s086=parcialDepois==='086'?'parcial':'completa';
      return {rows:[]};
    }
  }
  return {Client,sent,st,contagem:()=>({conectados,encerrados})};
}
const executar=(dir,extra={})=>m.executar({env,dir,raiz:root,disco:()=>{},...extra});
const ler=(dir,arq)=>JSON.parse(fs.readFileSync(path.join(dir,arq),'utf8'));
const migSql=f=>f.sent.filter(x=>/^(precheck|migration|postcheck) 08[56]$/.test(x));

test('arquivos 085/086 pelos hashes revisados; divergência recusa antes de conectar',()=>{
  assert.deepEqual(m.ETAPAS.map(x=>x[0]),['precheck 085','migration 085','postcheck 085','precheck 086','migration 086','postcheck 086']);
  for(const [,file,hash] of m.ETAPAS)assert.ok(m.lerRevisado(root,file,hash).length>100,file);
  assert.throws(()=>m.lerRevisado(root,m.ETAPAS[1][1],'0'.repeat(64)),/ARQUIVO_DIVERGENTE/);
});

test('modos: sem flag = plano; cada flag sozinha; combinações e argumentos soltos recusados',()=>{
  assert.equal(m.modo([]),'plano');
  assert.equal(m.modo(['--conferir-085-086']),'conferir');
  assert.equal(m.modo(['--aplicar-085-086-autorizado']),'aplicar');
  assert.equal(m.modo(['--retomar-085-086-autorizado']),'retomar');
  for(const argv of [['--aplicar-084-autorizado'],['--aplicar-085-086-autorizado','--conferir-085-086'],['--aplicar-085-086-autorizado','x'],['--conferir']])
    assert.throws(()=>m.modo(argv));
});

test('plano não lê DATABASE_URL, não constrói cliente nem grava arquivo',async()=>{
  const antes=process.env.DATABASE_URL; process.env.DATABASE_URL='postgresql://nao:usar@exemplo.invalid/x';
  try{
    const r=await m.principal([],{});
    assert.equal(r.codigo,0); assert.equal(r.saida.resultado,'PLANO'); assert.equal(r.saida.conecta,false);
    assert.equal(r.saida.arquivos.length,6);
    assert.ok(!JSON.stringify(r.saida).includes('exemplo.invalid'),'plano não reflete a URL');
  }finally{ if(antes===undefined)delete process.env.DATABASE_URL; else process.env.DATABASE_URL=antes; }
});

test('alvo aceita exclusivamente o serviço e o banco Render de staging',()=>{
  assert.match(m.alvo(env).connectionString,/kidmais_staging_1z91/);
  for(const change of [{RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg'},{KIDMAIS_DEPLOY_ENV:'production'},{RENDER:undefined},{DATABASE_URL:undefined},
    {DATABASE_URL:'postgresql://u:p@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production'},{DATABASE_URL:'postgresql://u:p@localhost:5432/kidmais_manager'},
    {DATABASE_URL:'postgresql://u:p@127.0.0.1:55563/kidmais_pacotes_v1_descartavel'},{DATABASE_URL:env.DATABASE_URL+'?host=localhost'},{DATABASE_URL:env.DATABASE_URL+'?sslmode=disable'},
    {DATABASE_SSL:undefined}])
    assert.throws(()=>m.alvo({...env,...change}),JSON.stringify(change));
});

test('schema sem 085/086: ordem exata, estado relido após cada migration, trava liberada, registro concluído',async()=>{
  const dir=tmp();
  try{const f=fake(),r=await executar(dir,{Client:f.Client});assert.equal(r.resultado,'PASS');
    assert.deepEqual(f.sent,['identidade','trava','estado','precheck 085','migration 085','estado','BEGIN TRANSACTION READ ONLY','postcheck 085','COMMIT',
      'precheck 086','migration 086','estado','BEGIN TRANSACTION READ ONLY','postcheck 086','COMMIT','estado','soltar']);
    assert.deepEqual(r.plano,['precheck 085','migration 085','postcheck 085','precheck 086','migration 086','postcheck 086']);
    assert.deepEqual(r.estadoDepois.preservacao,r.estadoAntes.preservacao);
    const reg=ler(dir,'migration-085-086.json'); assert.equal(reg.concluido,true); assert.equal(reg.tentativa,1);
    assert.deepEqual(f.contagem(),{conectados:1,encerrados:1});
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('085 já completa: só o postcheck 085 e a sequência da 086; ambas completas: só postchecks',async()=>{
  for(const [s085,s086,esperado] of [['completa','ausente',['postcheck 085','precheck 086','migration 086','postcheck 086']],['completa','completa',['postcheck 085','postcheck 086']]]){
    const dir=tmp();
    try{const f=fake({s085,s086}),r=await executar(dir,{Client:f.Client});assert.equal(r.resultado,'PASS');assert.deepEqual(migSql(f),esperado);}
    finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
});

test('recusas antes de qualquer SQL de migration: pré-requisito, parcial, incoerente, privilégio, concorrência, identidade',async()=>{
  const casos=[[{m083:false},/PRE_REQUISITO_AUSENTE 083/],[{m084:false},/PRE_REQUISITO_AUSENTE.*084/],[{s085:'parcial'},/INSTALACAO_PARCIAL 085/],
    [{s085:'completa',s086:'parcial'},/INSTALACAO_PARCIAL 086/],[{s086:'completa'},/ESTADO_INCOERENTE/],[{criar:false},/SEM_PRIVILEGIO 085/],
    [{referenciar:false},/SEM_PRIVILEGIO 085/],[{s085:'completa',gatilho:false},/SEM_PRIVILEGIO 086/],[{trava:false},/EXECUCAO_CONCORRENTE/],
    [{identity:{db:'kidmais_production',tls:false,servidor_privado:true}},/BANCO/],[{identity:{db:'kidmais_staging_1z91',tls:false,servidor_privado:false}},/REDE_PRIVADA/]];
  for(const [opcoes,msg] of casos){
    const dir=tmp();
    try{const f=fake(opcoes),r=await executar(dir,{Client:f.Client});assert.equal(r.resultado,'FALHA',JSON.stringify(opcoes));
      assert.match(r.falha.mensagem,msg); assert.deepEqual(migSql(f),[],'nenhum SQL de migration: '+JSON.stringify(opcoes));
      assert.deepEqual(r.migracoesCommitadas,[]); assert.equal(f.contagem().encerrados,1,'conexão encerrada');
      // A trava só é liberada quando foi obtida (não há o que soltar se outra sessão a segura ou se a identidade falhou antes).
      assert.equal(f.sent.includes('soltar'),f.sent.includes('trava')&&opcoes.trava!==false);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
});

test('precheck com booleano falso não envia a migration',async()=>{
  for(const [opcoes,nome,ultimo] of [[{},'precheck 085','precheck 085'],[{s085:'completa'},'precheck 086','precheck 086']]){
    const dir=tmp();
    try{const f=fake({...opcoes,precheckFalso:nome}),r=await executar(dir,{Client:f.Client});assert.equal(r.resultado,'FALHA');
      assert.match(r.falha.mensagem,new RegExp('PRECHECK_RECUSOU '+nome)); assert.equal(migSql(f).at(-1),ultimo);
      assert.ok(!f.sent.includes(nome.replace('precheck','migration')));
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
});

test('falha na 086 depois da 085: registra a 085 commitada, não executa down, pede retomada; retomada aplica só a 086',async()=>{
  const dir=tmp();
  try{const f=fake({fail:'migration 086'}),r=await executar(dir,{Client:f.Client});assert.equal(r.resultado,'FALHA');
    assert.equal(r.falha.etapa,'migration 086'); assert.deepEqual(r.migracoesCommitadas,['migration 085']);
    assert.ok(f.sent.every(x=>!/down|rollback 08/i.test(x)),'nenhum down');
    assert.equal(ler(dir,'migration-085-086.json').concluido,false);
    await assert.rejects(executar(dir,{Client:fake().Client}),/TENTATIVA_ANTERIOR_REVISAR/);
    const g=fake({s085:'completa'}),r2=await executar(dir,{Client:g.Client,retomar:true});assert.equal(r2.resultado,'PASS');
    assert.equal(r2.arquivo,'migration-085-086.tentativa-2.json'); assert.deepEqual(migSql(g),['postcheck 085','precheck 086','migration 086','postcheck 086']);
    await assert.rejects(executar(dir,{Client:fake().Client,retomar:true}),/JA_CONCLUIDO/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('postcheck falhando, estado parcial após migration e invariante alterada param com registro',async()=>{
  for(const [opcoes,msg,etapa] of [[{fail:'postcheck 085'},/falha simulada postcheck 085/,'postcheck 085'],[{parcialDepois:'085'},/ESTADO_DEPOIS migration 085/,'migration 085'],
    [{mudarConvites:true},/INVARIANTE_ALTERADA/,'postcheck 086']]){
    const dir=tmp();
    try{const f=fake(opcoes),r=await executar(dir,{Client:f.Client});assert.equal(r.resultado,'FALHA');assert.match(r.falha.mensagem,msg);assert.equal(r.falha.etapa,etapa);
      if(opcoes.fail)assert.ok(!f.sent.includes('precheck 086'),'não segue para a 086');
      assert.equal(ler(dir,'migration-085-086.json').concluido,false);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
});

test('retomada sem tentativa anterior é recusada; processo interrompido (sem conclusão) pode ser retomado',async()=>{
  const dir=tmp();
  try{await assert.rejects(executar(dir,{Client:fake().Client,retomar:true}),/NADA_A_RETOMAR/);
    fs.writeFileSync(path.join(dir,'migration-085-086.json'),JSON.stringify({tentativa:1,etapas:[{nome:'migration 085'}]}));
    const f=fake({s085:'completa'}),r=await executar(dir,{Client:f.Client,retomar:true});assert.equal(r.resultado,'PASS');
    assert.equal(r.arquivo,'migration-085-086.tentativa-2.json'); assert.deepEqual(ler(dir,r.arquivo).anteriores,['migration-085-086.json']);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('conferência é só leitura: prechecks/postchecks aplicáveis, nenhuma migration; recusa registrada como RECUSARIA',async()=>{
  for(const [opcoes,esperado,resultado] of [[{},['precheck 085'],'CONFERIDO'],[{s085:'completa'},['postcheck 085','precheck 086'],'CONFERIDO'],
    [{s085:'completa',s086:'completa'},['postcheck 085','postcheck 086'],'CONFERIDO'],[{m084:false},['precheck 085'],'RECUSARIA']]){
    const dir=tmp();
    try{const f=fake(opcoes),r=await m.conferir({env,dir,raiz:root,disco:()=>{},Client:f.Client});assert.equal(r.resultado,resultado);
      assert.deepEqual(migSql(f),esperado); assert.ok(!f.sent.some(x=>x.startsWith('migration')));
      assert.equal(r.arquivo,'conferencia-085-086-1.json'); assert.ok(!f.sent.includes('trava'));
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
});

test('senha e URL nunca aparecem no resultado nem nos registros',async()=>{
  const dir=tmp();
  try{
    class Quebra{async connect(){throw Error(`connect ECONNREFUSED ${env.DATABASE_URL}`);} async query(){} async end(){}}
    const r=await executar(dir,{Client:Quebra});assert.equal(r.resultado,'FALHA');
    const ok=fake(),r2=await m.conferir({env,dir,raiz:root,disco:()=>{},Client:ok.Client});
    const tudo=JSON.stringify(r)+JSON.stringify(r2)+fs.readdirSync(dir).map(a=>fs.readFileSync(path.join(dir,a),'utf8')).join('');
    assert.ok(!tudo.includes(SENHA),'senha'); assert.ok(!tudo.includes('postgresql://'),'url');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('estado ausente/completa/parcial pelas contagens',()=>{
  assert.equal(m.estadoMigration(0,0,11),'ausente'); assert.equal(m.estadoMigration(11,7,11),'completa');
  assert.equal(m.estadoMigration(3,0,11),'parcial'); assert.equal(m.estadoMigration(0,2,11),'parcial');
  assert.equal(m.estadoMigration(8,4,8,true),'completa'); assert.equal(m.estadoMigration(8,4,8,false),'parcial'); assert.equal(m.estadoMigration(0,0,8,true),'parcial');
});

test('P3-1: critérios de 083 e 084 iguais aos dos aplicadores de origem (texto normalizado)',()=>{
  const norm=s=>s.replace(/\s+/g,' ').trim();
  const expr=(sql,alias)=>{const t=norm(sql);const fim=t.indexOf(' AS '+alias);assert.ok(fim>0,alias);return t.slice(t.indexOf('SELECT ')+7,fim).replace(/^\(|\)$/g,'');};
  const m083=expr(require('./migration-083-staging.cjs').SQL_SCHEMA,'m083'), m084=expr(require('./migration-084-staging.cjs').SQL_SCHEMA,'m084');
  const estado=norm(m.SQL_ESTADO);
  assert.ok(estado.includes(m083),'m083 de origem: '+m083);
  assert.ok(estado.includes(m084.replace("conrelid='public.convite_geracoes'::regclass","conrelid=to_regclass('public.convite_geracoes')")),'m084 de origem (to_regclass: não falha sem a tabela): '+m084);
  assert.match(estado,/whatsapp_conexoes_ambiente_configurada_uk'\) IS NULL\) AS m083/);
});

test('P3-4: conferência que recusaria sai com código 3; conferida 0; falha de conexão 2',async()=>{
  for(const [opcoes,codigo,resultado] of [[{m084:false},3,'RECUSARIA'],[{},0,'CONFERIDO'],[{identity:{db:'outro',tls:false,servidor_privado:true}},2,'FALHA']]){
    const dir=tmp();
    try{const f=fake(opcoes),r=await m.principal(['--conferir-085-086'],env,{dir,raiz:root,disco:()=>{},Client:f.Client});
      assert.equal(r.saida.resultado,resultado);assert.equal(r.codigo,codigo,JSON.stringify(opcoes));
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
  assert.deepEqual({...m.CODIGO},{PLANO:0,CONFERIDO:0,PASS:0,FALHA:2,RECUSARIA:3});
});
