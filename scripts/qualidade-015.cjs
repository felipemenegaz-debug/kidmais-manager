/* eslint-disable @typescript-eslint/no-require-imports */
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),original=path.resolve(root,'../..');
if(path.basename(root)!=='implementacao-015')throw Error('Execute na cópia isolada.');
const checkpoint=JSON.parse(fs.readFileSync(path.join(original,'.tmp/checkpoint-015.json'),'utf8')).dest;
const baseline=new Map(JSON.parse(fs.readFileSync(path.join(original,checkpoint,'manifesto.json'),'utf8')).map(f=>[f.path,f.sha256]));
const sha=b=>createHash('sha256').update(b).digest('hex'),files=[];
function walk(dir=''){for(const e of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){if(['node_modules','.tmp','.next','.backups','.git'].includes(e.name))continue;const p=path.join(dir,e.name).replaceAll('\\','/');if(e.isDirectory())walk(p);else if(!['.env.local','next-env.d.ts','tsconfig.tsbuildinfo'].includes(p)){const hash=sha(fs.readFileSync(path.join(root,p)));if(baseline.get(p)!==hash)files.push({path:p,sha256:hash,status:baseline.has(p)?'alterado':'criado'});}}}walk();
const commands=[['TypeScript',['node_modules/typescript/bin/tsc','--noEmit','--incremental','false']],['lint',['node_modules/eslint/bin/eslint.js',...files.filter(f=>/\.(ts|tsx|cjs)$/.test(f.path)).map(f=>f.path)]],['build',['node_modules/next/dist/bin/next','build','--webpack']]];
const results=[];for(const [name,args]of commands){const r=spawnSync(process.execPath,args,{cwd:root,env:process.env,encoding:'utf8',maxBuffer:8*1024*1024,timeout:240000}),log='.tmp/015-'+name+'.log';fs.writeFileSync(path.join(root,log),(r.stdout??'')+(r.stderr??''));results.push({name,status:r.status,log});console.log(name,r.status===0?'PASS':'FALHOU');if(r.status!==0)console.log(r.stdout,r.stderr);}
fs.writeFileSync(path.join(root,'.tmp/015-qualidade.json'),JSON.stringify({files,results},null,2));if(results.some(r=>r.status!==0))process.exitCode=1;
