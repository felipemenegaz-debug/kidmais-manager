/* eslint-disable @typescript-eslint/no-require-imports */
// Exportacao somente leitura do banco fixo. Dump confidencial fica no disco persistente, nunca no Git/chat.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const {alvo,ALVO}=require('./diagnostico-lancamento-production.cjs');
const {identidadeProduction,HASH_MANIFESTO}=require('./migrations-lancamento-production.cjs');
const DISCO='/opt/render/project/src/data',BASE=path.join(DISCO,'lancamento-venda-20261011');
function recente(iso,agora=Date.now()){const idade=agora-Date.parse(iso);assert.ok(idade>=0&&idade<86400000,'PITR_NAO_CONFERIDO_RECENTEMENTE');return iso;}
function ambientePg(env){
 const opts=alvo(env),u=new URL(opts.connectionString),filho={};
 for(const k of ['PATH','HOME','LANG','LC_ALL','LD_LIBRARY_PATH','SSL_CERT_FILE','SSL_CERT_DIR'])if(env[k]!==undefined)filho[k]=env[k];
 Object.assign(filho,{PGHOST:ALVO.host,PGPORT:String(ALVO.port),PGDATABASE:ALVO.database,PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGSSLMODE:opts.ssl.rejectUnauthorized?'verify-full':'require',PGCONNECT_TIMEOUT:'5',PGAPPNAME:'kidmais-backup-lancamento',PGOPTIONS:'-c default_transaction_read_only=on -c statement_timeout=240000 -c lock_timeout=5000'});
 return filho;
}
function executar(bin,args,env,timeout=300000){
 const r=spawnSync(bin,args,{env,encoding:'utf8',stdio:['ignore','ignore','pipe'],timeout,windowsHide:true});
 // Saida de erro de libpq pode conter detalhes de conexao: jamais propagar.
 assert.ok(!r.error&&r.status===0,'FERRAMENTA_BACKUP_FALHOU '+bin);return r;
}
function versao(bin,env){
 const r=spawnSync(bin,['--version'],{env,encoding:'utf8',timeout:5000,windowsHide:true});
 assert.ok(!r.error&&r.status===0,'BINARIO_INDISPONIVEL '+bin);
 const n=Number((r.stdout.match(/PostgreSQL\)\s+(\d+)/)||[])[1]);assert.equal(n,18,'VERSAO_BINARIO_DIVERGENTE '+bin);
}
async function exportar({env=process.env,pitr,criarCliente,rodar=executar,versaoBin=versao,discoFs=fs,plataforma=process.platform}={}){
 const limite=Date.now()+540000;
 const restante=()=>{const ms=limite-Date.now();assert.ok(ms>0,'TEMPO_TOTAL_BACKUP_EXCEDIDO');return Math.min(ms,240000);};
 const opts=alvo(env);recente(pitr);assert.equal(plataforma,'linux','PLATAFORMA_RECUSADA');
 const mount=discoFs.lstatSync(DISCO);assert.ok(mount.isDirectory()&&!mount.isSymbolicLink()&&mount.dev!==discoFs.statSync(path.dirname(DISCO)).dev,'DISCO_NAO_MONTADO');
 for(const k of ['CADASTRO_PUBLICO_ATIVO','ASSINATURA_PLANOS_ATIVOS','COTACAO_PUBLICA_POR_EMPRESA'])assert.notEqual(env[k],'true','FLAG_DE_ABERTURA_ATIVA '+k);
 const pgEnv=ambientePg(env);versaoBin('pg_dump',pgEnv);versaoBin('pg_restore',pgEnv);
 const c=criarCliente?criarCliente(opts):new(require('pg').Client)({...opts,application_name:'kidmais-backup-identidade'});c.on('error',()=>undefined);
 try{await c.connect();await c.query('BEGIN TRANSACTION READ ONLY');identidadeProduction((await c.query('SELECT current_database() AS db, (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls')).rows[0]);}
 finally{await c.query('ROLLBACK').catch(()=>{});await c.end().catch(()=>{});}
 discoFs.mkdirSync(BASE,{recursive:true,mode:0o700});const dir=discoFs.lstatSync(BASE);assert.ok(dir.isDirectory()&&!dir.isSymbolicLink(),'DIRETORIO_BACKUP_RECUSADO');discoFs.chmodSync(BASE,0o700);
 const arquivo='backup-'+randomUUID()+'.dump',dump=path.join(BASE,arquivo),registro=path.join(BASE,arquivo.replace('.dump','.json'));
 discoFs.closeSync(discoFs.openSync(dump,'wx',0o600));
 rodar('pg_dump',['--format=custom','--file='+dump,'--no-password'],pgEnv,restante());
 assert.ok(discoFs.statSync(dump).size>0,'BACKUP_VAZIO');
 // Le o arquivo inteiro, descompacta e gera SQL descartado. Nao conecta a destino nem restaura banco.
 rodar('pg_restore',['--file=/dev/null',dump],pgEnv,restante());
 const h=createHash('sha256');for await(const chunk of discoFs.createReadStream(dump)){restante();h.update(chunk);}
 const b={servico:ALVO.servico,banco:ALVO.database,arquivo,sha256:h.digest('hex'),criadoEm:new Date().toISOString(),pitrConferidoEm:pitr,manifestoSha256:HASH_MANIFESTO,arquivoIntegralmenteLido:true,restauracaoRealComprovada:false};
 discoFs.writeFileSync(registro,JSON.stringify(b,null,2),{flag:'wx',mode:0o600});return {resultado:'BACKUP_CUSTOM_CONFERIDO_SEM_RESTORE',registro};
}
async function main(){
 const args=process.argv.slice(2);
 if(JSON.stringify(args)===JSON.stringify(['--plano'])){console.log(JSON.stringify({modo:'PLANO_SEM_CONEXAO',alvo:ALVO,diretorio:BASE,efeito:'Exporta e confere arquivo; nao altera nem restaura banco.'}));return;}
 assert.equal(args.length,3,'USO_RECUSADO');assert.equal(args[0],'--backup-production-autorizado');assert.equal(args[1],'--pitr-confirmado');
 console.log(JSON.stringify(await exportar({pitr:args[2]})));
}
if(require.main===module)main().catch(e=>{console.error(String(e.message).slice(0,160));process.exitCode=1;});
module.exports={recente,ambientePg,executar,versao,exportar};
