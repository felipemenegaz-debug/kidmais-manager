/* eslint-disable @typescript-eslint/no-require-imports -- Prova offline CJS da revisão R1; comportamento preservado. */
/* Provas independentes locais. Sem pg, rede, dependências ou leitura de .env. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{stripTypeScriptTypes}=require('node:module');
const {DatabaseSync}=require('node:sqlite');
delete process.env.DATABASE_URL;delete process.env.KIDMAIS_HOMOLOGACAO_DATABASE_URL;
const root=path.resolve(__dirname,'../../..');process.chdir(root);
const read=p=>fs.readFileSync(p,'utf8');
function load(file,deps,names){let js=stripTypeScriptTypes(read(file));js=js.replace(/^import .*?;\s*$/gm,'').replace(/\bexport /g,'');return new Function(...Object.keys(deps),js+'\nreturn {'+names.join(',')+'};')(...Object.values(deps));}
const results=[];const note=(name,data)=>results.push({name,...data});
(async()=>{
 const manifest=JSON.parse(read('docs/evidencias/funil-20261114/manifesto.json'));
 const hashes=manifest.arquivos.map(x=>({arquivo:x.arquivo,igual:createHash('sha256').update(fs.readFileSync(x.arquivo)).digest('hex')===x.sha256}));
 assert.equal(hashes.length,45);assert(hashes.every(x=>x.igual));note('manifesto',{arquivos:hashes});
 const inv=await import(require('node:url').pathToFileURL(path.join(root,'scripts/production/check-migrations.mjs')).href);
 const area=path.resolve(root,'../kidmais-manager-area-familia-20261114');
 const invArea=await import(require('node:url').pathToFileURL(path.join(area,'scripts/production/check-migrations.mjs')).href);
 const r=invArea.inspectInventory(fs.readdirSync(path.join(area,'database/migrations')),f=>fs.existsSync(path.join(area,'database/checks',f)));
 assert.deepEqual(r.blockers,[]);assert(!invArea.approvedFiles.some(f=>f.includes('_122_')));assert(invArea.approvedFiles.some(f=>f.includes('_123_')));
 const combined=[...invArea.approvedFiles,...inv.approvedFiles.filter(f=>f.includes('_122_'))];
 note('ordem-inventario',{areaSem122:r.blockers,finalArea:invArea.approvedFiles.slice(-3),integracaoAppend:combined.slice(-3),modelo122Inclui123:combined.slice(0,combined.findIndex(f=>f.includes('_122_'))+1).some(f=>f.includes('_123_'))});
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE marketing_contatos(id TEXT,empresa_id TEXT,nome TEXT,cliente_id TEXT,status TEXT,data_desejada TEXT,responsavel_id TEXT,recebido_em TEXT,fechamento_id TEXT);
 CREATE TABLE fechamentos(id TEXT,empresa_id TEXT,cliente_id TEXT,status TEXT,iniciado_em TEXT);
 INSERT INTO fechamentos VALUES('f-antigo','empresa-a','cliente-a','CONFIRMADO','2025-01-01');
 INSERT INTO marketing_contatos VALUES('contato-novo','empresa-a','Família sintética','cliente-a','EM_ATENDIMENTO',NULL,NULL,'2026-11-14',NULL);`);
 // Primeiro braço real da CTE, somente retirando casts de PostgreSQL.
 const sql=read('lib/oportunidades/consultas.ts').match(/const BASE = `WITH alvos AS \(([\s\S]*?) UNION ALL/)[1].replace(/::(?:text|numeric|uuid)/g,'');
 const observed=db.prepare(sql).all({$1:'empresa-a'});assert.equal(observed.length,0);
 const explicit=db.prepare('SELECT id FROM marketing_contatos WHERE fechamento_id IS NULL').all();assert.equal(explicit.length,1);
 note('retorno-cliente',{sql,cartoesObservados:observed.length,contatosSemVinculo:explicit.length,estadoNegociacaoAnterior:'CONFIRMADO',anterior:'2025-01-01',novo:'2026-11-14'});db.close();
 let action={id:'acao',contato_id:'contato',criada_por:'autor',responsavel_id:'vendedor-b'},f={empresa_id:'empresa',cliente_id:'cliente',usuario_responsavel_id:'vendedor-a'};const writes=[];
 const conversion=load('lib/oportunidades/conversao.ts',{registrarEventoHistorico:async()=>{}},['herdarAcoesDoContato']);
 await conversion.herdarAcoesDoContato({query:async(sql,args)=>{
  if(sql.includes('to_regclass'))return {rows:[{ok:true}]};
  if(sql.startsWith('SELECT empresa_id'))return {rows:[f]};
  if(sql.includes('JOIN marketing_contatos'))return {rows:[action]};
  if(sql.startsWith('SELECT 1'))return {rows:[]};
  writes.push(sql);if(sql.startsWith('UPDATE oportunidades_acoes'))action={...action,contato_id:null,fechamento_id:args[2]};
  return {rows:[]};
 }},'fechamento');
 assert.equal(action.fechamento_id,'fechamento');assert.equal(f.usuario_responsavel_id,'vendedor-a');
 note('responsavel-conversao',{writes,responsavelCartao:action.responsavel_id,responsavelContadorMensal:f.usuario_responsavel_id});
 let rows=new Map(),calls=0,sends=[],fail=false,crash=false;
 const item={id:'contato',nome:'Sintético',proxima:{id:'acao',tipo:'Ligar',data:'2026-11-14'}};
 const tx={query:async(sql,args)=>{
  calls++;
  if(sql.startsWith('SELECT email'))return {rows:[{email:'sintetico@example.test'}]};
  if(sql.startsWith('INSERT INTO oportunidades_resumos')){const k=args.slice(0,3).join('/');if(!rows.has(k))rows.set(k,{estado:'PENDENTE',mensagem:JSON.parse(args[3])});return {rows:[]};}
  if(sql.startsWith('SELECT mensagem'))return {rows:[rows.get(args.slice(0,3).join('/'))].filter(Boolean)};
  if(sql.startsWith('UPDATE oportunidades_resumos')){rows.get(args.slice(0,3).join('/')).estado=args[3];return {rows:[]};}
  throw Error('SQL inesperado: '+sql);
 }};
 const worker=load('lib/oportunidades/resumo.ts',{withTenantTransaction:null,hojeSaoPaulo:()=> '2026-11-14',listarOportunidades:async()=>[item],exigirRecursoPlano:async()=>{},exigirCapacidadeMarketing:async()=>{}},['enviarResumosDiarios','mensagemResumo']);
 let queue=Promise.resolve();
 const tenant=async(sessao,_,fn)=>{let release;const previous=queue;queue=new Promise(r=>release=r);await previous;const before=structuredClone(rows);try{const out=await fn(tx,{empresaComprovada:sessao.empresa_ativa_id,usuarioId:sessao.usuario_id});if(crash&&[...rows.values()].some(x=>x.estado==='ENVIADO')){crash=false;throw Error('commit perdido sintético');}return out;}catch(e){rows=before;throw e;}finally{release();}};
 const deps={env:{OPORTUNIDADES_RESUMO_EMAIL:'true'},tenant,transacao:async(fn)=>fn({query:async()=>({rows:[{empresa_id:'empresa-a',usuario_id:'usuario-a'}]})}),enviar:async(m)=>{sends.push(m);if(fail)throw Error('transporte sintético');return {};}};
 await worker.enviarResumosDiarios({...deps,env:{}});assert.equal(calls,0);assert.equal(sends.length,0);
 await Promise.all([worker.enviarResumosDiarios(deps),worker.enviarResumosDiarios(deps)]);assert.equal(sends.length,1);
 note('worker-default-concorrencia',{desligadoConsultas:0,duasInvocacoesEnvios:sends.length,limite:'serialização transacional em memória; não prova locks PostgreSQL'});
 rows.clear();sends=[];fail=true;await worker.enviarResumosDiarios(deps);await worker.enviarResumosDiarios(deps);assert.equal(sends.length,1);assert.equal([...rows.values()][0].estado,'FALHOU');note('worker-falha',{envios:sends.length,estado:'FALHOU'});
 rows.clear();sends=[];fail=false;crash=true;await worker.enviarResumosDiarios(deps);await worker.enviarResumosDiarios(deps);assert.equal(sends.length,2);assert.deepEqual(sends[0],sends[1]);note('worker-crash',{tentativas:2,mesmaChaveEConteudo:true,limite:'deduplicação do provedor não executada'});
 const {criarAplicador}=require(path.join(root,'scripts/migration-122-comum.cjs'));
 // filesystem inteiramente falso: nenhum marcador real, pasta ou conexão.
 const original={mkdirSync:fs.mkdirSync,writeFileSync:fs.writeFileSync};let marker='MARCADOR_ANTERIOR',queries=[];
 try{
 fs.mkdirSync=()=>{};fs.writeFileSync=(_p,body,options)=>{if(options?.flag==='wx'&&marker!==null)throw Object.assign(Error('existe'),{code:'EEXIST'});marker=body;};
 let commitLost=false;const amb={nome:'fake',DIR:'fake',SQL_IDENTIDADE:'IDENTIDADE',identidade:()=>{},alvo:()=>({}),exigirDisco:()=>{}};
 class Client {async connect(){}async end(){}async query(sql){queries.push(sql);if(sql.includes('has_schema_privilege'))return {rows:[{uso:true,criar:true,dono:true,referencias:true}]};if(sql.includes("AS a,"))return {rows:[{a:false,m:false,r:false,f:false,c:false}]};if(sql==='COMMIT'&&commitLost&&queries.includes('BEGIN'))throw Object.assign(Error('conexão caiu'),{code:'ECONNRESET'});return {rows:[{}],command:sql==='COMMIT'?'COMMIT':''};}}
 const app=criarAplicador(amb);let out=await app.principal(['--aplicar-122-autorizado','--backup','backup-falso'],{},{Client});assert.equal(out.codigo,1);assert.equal(marker,'MARCADOR_ANTERIOR');assert(!queries.includes('BEGIN'));note('marcador-existente',{codigo:out.codigo,preservado:true,transacaoEscrita:false});
 marker=null;queries=[];commitLost=true;out=await app.principal(['--aplicar-122-autorizado','--backup','backup-falso'],{},{Client});assert.equal(out.codigo,2);assert.equal(out.saida.commit,'INDETERMINADO');assert.equal(JSON.parse(marker).commit,'INDETERMINADO');note('commit-incerto',{codigo:out.codigo,commit:out.saida.commit,marcadorPreservado:true});
 }finally{Object.assign(fs,original);}
 fs.writeFileSync(path.join(__dirname,'resultado.json'),JSON.stringify({utc:new Date().toISOString(),runtime:process.version,rede:false,postgres:false,resultados:results},null,2)+'\n');console.log(JSON.stringify({PASS:true,provas:results.length}));
})().catch(e=>{console.error(e);process.exitCode=1;});
