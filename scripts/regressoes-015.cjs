/* eslint-disable @typescript-eslint/no-require-imports */
const {spawnSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
if(!/^\/kidmais_015_\d+$/.test(new URL(process.env.DATABASE_URL).pathname))throw Error('Somente clone de validação 015.');
const unit=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(p.endsWith('.test.ts'))unit.push(p);}}walk('lib');
const commands=[['unitários',['--experimental-strip-types','--test',...unit]],...['pricing-service','identidade-repository','identidade-service','identidade-fechamento'].map(n=>[n,['-r','./scripts/pagamentos-test-support.cjs','-e',`require('./scripts/${n}.integration.ts')`]])];
const results=[];for(const [nome,args] of commands){const r=spawnSync(process.execPath,args,{encoding:'utf8',env:process.env,timeout:120000});const log='.tmp/015-'+nome+'.log';fs.writeFileSync(log,(r.stdout??'')+(r.stderr??''));results.push({nome,status:r.status,log});console.log(nome,r.status===0?'PASS':'FALHOU');if(r.status!==0)console.log(r.stdout,r.stderr);}
fs.writeFileSync('.tmp/regressoes-015.json',JSON.stringify(results,null,2));if(results.some(r=>r.status!==0))process.exitCode=1;
