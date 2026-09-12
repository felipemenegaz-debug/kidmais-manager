/* eslint-disable @typescript-eslint/no-require-imports */
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const changes=JSON.parse(fs.readFileSync('.tmp/verificacao-final-014.json')).arquivos;
const files=[...new Set([...changes.map(x=>x.path).filter(p=>/\.(ts|tsx|cjs)$/.test(p)),'lib/contratos/services/alteracoes.ts','scripts/qualidade-014.cjs'])];
const results=[];
function run(name,args,options={}){const r=spawnSync(process.execPath,args,{env:process.env,encoding:'utf8',timeout:240000,...options});const log='.tmp/qualidade-014-'+name+'.log';fs.writeFileSync(log,(r.stdout||'')+(r.stderr||''));results.push({name,status:r.status,log,error:r.error?.message});console.log(name,r.status===0?'PASSOU':'FALHOU');if(r.status!==0)console.log((r.stdout||'')+(r.stderr||''));}
run('lint',['node_modules/eslint/bin/eslint.js',...files]);
run('typescript',['node_modules/typescript/bin/tsc','--noEmit']);
const workspace=path.resolve('.tmp/build-014-'+Date.now());fs.mkdirSync(workspace,{recursive:true});
for(const e of fs.readdirSync('.',{withFileTypes:true})){if(['node_modules','.next','.tmp','.backups','.git','.env.local','tsconfig.tsbuildinfo'].includes(e.name))continue;fs.cpSync(e.name,path.join(workspace,e.name),{recursive:true});}
fs.symlinkSync(path.resolve('node_modules'),path.join(workspace,'node_modules'),'junction');
run('build',[path.resolve('node_modules/next/dist/bin/next'),'build','--webpack'],{cwd:workspace,env:{...process.env,NODE_ENV:'production'}});
fs.writeFileSync('.tmp/qualidade-014.json',JSON.stringify({workspace,files,results},null,2));if(results.some(r=>r.status!==0))process.exitCode=1;
