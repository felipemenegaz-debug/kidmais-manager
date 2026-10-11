/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador delimitado: uma migration por chamada, backup conferido, SQL revisado e transacao unica com postcheck.
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const {createHash}=require('node:crypto');
const {alvo,ALVO,MIGRATIONS}=require('./diagnostico-lancamento-production.cjs');
const MANIFESTO='docs/MIGRATIONS_PRODUCTION_LANCAMENTO_20261011.json';
const HASH_MANIFESTO='628eb4f66dd843073725a8ec7c44669b777637facdcede14c8a87e24d1c55c26';
const DISCO='/opt/render/project/src/data';
function hash(s){return createHash('sha256').update(s).digest('hex');}
function ler(raiz,arquivo){return fs.readFileSync(path.join(raiz,arquivo),'utf8').replace(/\r\n/g,'\n');}
function carregar(raiz=path.resolve(__dirname,'..')){
 const texto=ler(raiz,MANIFESTO);assert.equal(hash(texto),HASH_MANIFESTO,'MANIFESTO_DIVERGENTE');
 const m=JSON.parse(texto);assert.deepEqual(m.alvo,ALVO,'ALVO_MANIFESTO_DIVERGENTE');
 return m.migrations.map(e=>({...e,arquivos:e.arquivos.map(a=>{const sql=ler(raiz,a.arquivo);assert.equal(hash(sql),a.sha256,'SQL_DIVERGENTE '+a.arquivo);return {...a,sql};})}));
}
// Remove somente as molduras SQL externas; corpos DO/funcoes ficam literalmente intactos.
function corpo(sql,tipo){
 const linhas=sql.split('\n'), inicio=linhas.filter(l=>/^\s*BEGIN(?: TRANSACTION READ ONLY)?;\s*$/i.test(l));
 const fim=linhas.filter(l=>/^\s*(?:COMMIT|ROLLBACK);\s*$/i.test(l));
 if(tipo==='migration'){assert.deepEqual(inicio,['BEGIN;'],'MOLDURA_MIGRATION_DIVERGENTE');assert.deepEqual(fim,['COMMIT;'],'FIM_MIGRATION_DIVERGENTE');}
 else {assert.ok(inicio.length<=1&&fim.length<=1,'MOLDURA_CHECK_DIVERGENTE');assert.ok(!/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i.test(sql),'CHECK_NAO_LEITURA');}
 return linhas.filter(l=>!/^\s*(?:BEGIN(?: TRANSACTION READ ONLY)?|COMMIT|ROLLBACK);\s*$/i.test(l)).join('\n');
}
function identidadeProduction(r){assert.equal(r.db,ALVO.database,'BANCO_DIVERGENTE');assert.equal(r.tls,true,'SEM_TLS');}
async function etapa(c,plano,id,{registrar=()=>{},validarIdentidade=identidadeProduction}={}){
 const i=plano.findIndex(x=>x.id===id);assert.ok(i>=0,'MIGRATION_FORA_DO_PACOTE');
 const e=plano[i], expressao=MIGRATIONS.find(([m])=>m===id)[1];
 await c.query('BEGIN TRANSACTION READ ONLY');
 let aplicada;
 try {
  await c.query("SET LOCAL statement_timeout='15s'");
  const r=(await c.query('SELECT current_database() AS db, (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls')).rows[0];
  validarIdentidade(r);
  for(const anterior of plano.slice(0,i)){assert.equal((await c.query('SELECT ('+MIGRATIONS.find(([m])=>m===anterior.id)[1]+') AS presente')).rows[0].presente,true,'DEPENDENCIA_AUSENTE '+anterior.id);}
  aplicada=(await c.query('SELECT ('+expressao+') AS presente')).rows[0].presente;assert.equal(typeof aplicada,'boolean','SCHEMA_ILEGIVEL');
 }finally{await c.query('ROLLBACK').catch(()=>{});}
 const sqls=e.arquivos.map(a=>({...a,sql:corpo(a.sql,a.tipo)}));
 registrar({etapa:id,situacao:'ANTES_DA_TRANSACAO',jaAplicada:aplicada});
 await c.query(aplicada?'BEGIN TRANSACTION READ ONLY':'BEGIN');
 try{
  await c.query("SET LOCAL lock_timeout='5s'");await c.query("SET LOCAL statement_timeout='60s'");
  for(const s of sqls.filter(x=>!aplicada||x.tipo==='postcheck'))await c.query(s.sql);
  await c.query('COMMIT');registrar({etapa:id,situacao:'COMMIT_CONFIRMADO',jaAplicada:aplicada});
  return {id,resultado:aplicada?'JA_APLICADA_POSTCHECK_PASS':'APLICADA_POSTCHECK_PASS'};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
}
async function conferirBackup(arquivo,agora=Date.now(),discoFs=fs){
 const base=path.resolve(DISCO,'lancamento-venda-20261011'), nome=path.resolve(arquivo);
 assert.equal(path.dirname(nome),base,'REGISTRO_FORA_DO_DISCO');
 const mount=discoFs.lstatSync(DISCO);assert.ok(mount.isDirectory()&&!mount.isSymbolicLink()&&mount.dev!==discoFs.statSync(path.dirname(DISCO)).dev,'DISCO_NAO_MONTADO');
 assert.ok(!discoFs.lstatSync(base).isSymbolicLink()&&!discoFs.lstatSync(nome).isSymbolicLink(),'REGISTRO_BACKUP_LINK_RECUSADO');
 const b=JSON.parse(discoFs.readFileSync(nome,'utf8'));
 assert.equal(b.servico,ALVO.servico);assert.equal(b.banco,ALVO.database);
 assert.equal(b.manifestoSha256,HASH_MANIFESTO,'BACKUP_PACOTE_DIVERGENTE');
 assert.equal(b.arquivoIntegralmenteLido,true,'BACKUP_NAO_CONFERIDO');
 assert.ok(agora-Date.parse(b.criadoEm)>=0&&agora-Date.parse(b.criadoEm)<86400000,'BACKUP_ANTIGO');
 assert.ok(agora-Date.parse(b.pitrConferidoEm)>=0&&agora-Date.parse(b.pitrConferidoEm)<86400000,'PITR_NAO_CONFERIDO');
 assert.match(b.sha256,/^[a-f0-9]{64}$/);assert.match(b.arquivo,/^backup-[a-zA-Z0-9-]+\.dump$/);
 const dump=path.join(base,b.arquivo);assert.ok(!discoFs.lstatSync(dump).isSymbolicLink(),'BACKUP_LINK_RECUSADO');
 assert.ok(discoFs.statSync(dump).size>0,'BACKUP_VAZIO');
 const h=createHash('sha256');for await(const chunk of discoFs.createReadStream(dump))h.update(chunk);
 assert.equal(h.digest('hex'),b.sha256,'BACKUP_HASH_DIVERGENTE');return b;
}
async function main(){
 const args=process.argv.slice(2), plano=carregar();
 if(args.length===0||JSON.stringify(args)===JSON.stringify(['--plano'])){console.log(JSON.stringify({modo:'PLANO_SEM_CONEXAO',alvo:ALVO,migrations:plano.map(e=>({id:e.id,arquivos:e.arquivos.map(a=>({tipo:a.tipo,arquivo:a.arquivo,sha256:a.sha256}))}))},null,2));return;}
 assert.equal(args.length,4,'USO_RECUSADO');assert.equal(args[0],'--aplicar-migration-autorizada');assert.equal(args[2],'--backup');
 assert.ok(plano.some(e=>e.id===args[1]),'MIGRATION_RECUSADA');
 const opts=alvo(process.env);await conferirBackup(args[3]);
 for(const k of ['CADASTRO_PUBLICO_ATIVO','ASSINATURA_PLANOS_ATIVOS','COTACAO_PUBLICA_POR_EMPRESA'])assert.notEqual(process.env[k],'true','FLAG_DE_ABERTURA_ATIVA '+k);
 const dir=path.join(DISCO,'lancamento-venda-20261011'), tentativa=path.join(dir,'migration-'+args[1]+'.json');
 // Marcador exclusivo impede replay se o processo morrer ou perder a resposta do COMMIT.
 fs.writeFileSync(tentativa,JSON.stringify({inicio:new Date().toISOString(),id:args[1],situacao:'INICIADA'}),{flag:'wx',mode:0o600});
 const salvar=r=>fs.writeFileSync(tentativa,JSON.stringify(r),{mode:0o600});
 const c=new(require('pg').Client)({...opts,application_name:'kidmais-cutover-migration-'+args[1]});c.on('error',()=>undefined);
 try {await c.connect();console.log(JSON.stringify(await etapa(c,plano,args[1],{registrar:salvar})));}
 finally{await c.end().catch(()=>{});}
}
if(require.main===module)main().catch(e=>{console.error(String(e.message).slice(0,160));process.exitCode=1;});
module.exports={ALVO,MANIFESTO,HASH_MANIFESTO,carregar,corpo,etapa,conferirBackup,identidadeProduction};
