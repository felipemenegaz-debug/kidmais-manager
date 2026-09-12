/* eslint-disable @typescript-eslint/no-require-imports */
require('./festa-016-test-environment.cjs').assertAutomated();
/* eslint-disable @typescript-eslint/no-require-imports */
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
if(!/^\/kidmais_016_\d+$/.test(new URL(process.env.DATABASE_URL).pathname))throw Error('Execute somente no clone 016.');
async function main(){
const {Client}=require('pg'),{randomBytes}=require('node:crypto');
const source=new URL(process.env.DATABASE_URL),name='kidmais_015_'+Date.now(),env={...process.env,PGPASSWORD:decodeURIComponent(source.password)},args=['-h',source.hostname,'-p',source.port||'5432','-U',decodeURIComponent(source.username)];
const dump='.local-festa/results/regression.dump',bin='C:/Program Files/PostgreSQL/18/bin/';
if(spawnSync(bin+'pg_dump.exe',[...args,'-Fc','-f',dump,source.pathname.slice(1)],{env}).status!==0)throw Error('Dump clone falhou');
const c=new Client({connectionString:source.toString()});await c.connect();await c.query('CREATE DATABASE "'+name+'"');await c.end();
if(spawnSync(bin+'pg_restore.exe',[...args,'--exit-on-error','--no-owner','--no-privileges','-d',name,dump],{env}).status!==0)throw Error('Restore clone regressão falhou');
const legacy=new URL(source);legacy.pathname='/'+name;
process.env.IDENTIDADE_OTP_PEPPER=randomBytes(32).toString('hex');process.env.IDENTIDADE_OTP_PROVIDER='console';process.env.CONTRATO_ACEITE_DEV_ENABLED='true';
const unit=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(p.endsWith('.test.ts'))unit.push(p);}}walk('lib');
const commands=[['unitarios',['--experimental-strip-types','--test',...unit]],
 ...['pricing-service','identidade-repository','identidade-service','identidade-fechamento'].map(n=>[n,['-r','./scripts/pagamentos-test-support.cjs','-e',`require('./scripts/${n}.integration.ts')`]]),
 ...['pagamentos-engenharia.integration','pagamentos-http.integration','pagamentos-concorrencia.integration','condicao-pagamento.integration','financeiro-http-015.integration','financeiro-fluxo-015.integration','credito-devolucao-015.integration','casos-financeiros-015.integration','movimentos-015.integration','revisao-operacional.integration','admin-contrato.integration'].map(n=>[n,['scripts/'+n+'.cjs']])];
const results=[];for(const [nome,args] of commands){const r=spawnSync(process.execPath,args,{encoding:'utf8',env:{...process.env,DATABASE_URL:legacy.toString()},timeout:240000,maxBuffer:8*1024*1024});const log='.local-festa/results/'+nome+'.log';fs.writeFileSync(log,(r.stdout??'')+(r.stderr??''));results.push({nome,status:r.status,log});console.log(nome,r.status===0?'PASS':'FALHOU');if(r.status!==0)console.log((r.stdout??'').slice(-1200),(r.stderr??'').slice(-1800));}
fs.writeFileSync('.local-festa/results/regressions.json',JSON.stringify(results,null,2));if(results.some(r=>r.status!==0))process.exitCode=1;

}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
