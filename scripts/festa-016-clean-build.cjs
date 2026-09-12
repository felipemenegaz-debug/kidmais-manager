/* eslint-disable @typescript-eslint/no-require-imports */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
assert.match(new URL(process.env.DATABASE_URL).pathname,/^\/kidmais_016_\d+$/);
const root=process.cwd(),copy=fs.mkdtempSync(path.join(root,'.local-festa','clean-build-'));
for(const e of fs.readdirSync(root,{withFileTypes:true})){
 if(e.name.startsWith('.')||e.name==='node_modules'||e.name.endsWith('.zip')||e.name.endsWith('.tsbuildinfo'))continue;
 fs.cpSync(path.join(root,e.name),path.join(copy,e.name),{recursive:true});
}
fs.symlinkSync(path.join(root,'node_modules'),path.join(copy,'node_modules'),'junction');
assert(!fs.existsSync(path.join(copy,'.next-festa')));
const saved=['next-env.d.ts','tsconfig.json'].map(p=>[p,fs.readFileSync(path.join(copy,p))]);
const run=(args,isolado)=>{const r=spawnSync(process.execPath,args,{cwd:copy,env:{...process.env,KIDMAIS_FESTA_ISOLADO:isolado?'true':'false'},encoding:'utf8',timeout:300000,maxBuffer:10*1024*1024});fs.appendFileSync('.local-festa/results/clean-build.log',(r.stdout??'')+(r.stderr??''));assert.equal(r.status,0,args.join(' '));};
fs.writeFileSync('.local-festa/results/clean-build.log','');
try{
 run(['node_modules/next/dist/bin/next','typegen'],false);
 run(['node_modules/typescript/bin/tsc','--noEmit','--incremental','false'],false);
 run(['node_modules/next/dist/bin/next','build','--webpack'],true);
}finally{for(const [p,b] of saved)fs.writeFileSync(path.join(copy,p),b);}
for(const [p,b] of saved)assert(fs.readFileSync(path.join(copy,p)).equals(b));
fs.writeFileSync('.local-festa/results/clean-build.json',JSON.stringify({copy,semNextFestaInicial:true,typegen:true,typescript:true,build:true,arquivosRestaurados:true}));
console.log('PASS cópia limpa: typegen/TypeScript/build sem .next-festa anterior; arquivos gerados restaurados.');
