/* eslint-disable @typescript-eslint/no-require-imports */
// Runner exclusivo da cópia isolada. Cada execução restaura um clone novo do checkpoint.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),{Client}=require('pg'),{createHash}=require('node:crypto');
async function main(){
 const root=path.resolve(__dirname,'..');
 if(path.basename(root)!=='implementacao-015'||path.basename(path.dirname(root))!=='.tmp')throw Error('Execute somente no ambiente isolado 015.');
 fs.mkdirSync(path.join(root,'.tmp'),{recursive:true});
 const source=path.resolve(root,'../..'),checkpoint=JSON.parse(fs.readFileSync(path.join(source,'.tmp/checkpoint-015.json'),'utf8')).dest;
 const url=new URL(process.env.DATABASE_URL);if(!/^kidmais_015_\d+$/.test(url.pathname.slice(1)))throw Error('Conexão de origem deve ser clone 015.');
 const banco='kidmais_015_'+Date.now(),admin=new URL(url);admin.pathname='/postgres';
 const c=new Client({connectionString:admin.toString()});await c.connect();try{await c.query(`CREATE DATABASE "${banco}" TEMPLATE template0`);}finally{await c.end();}
 const env={...process.env,PGPASSWORD:decodeURIComponent(url.password)};
 const restore=cp.spawnSync('C:/Program Files/PostgreSQL/18/bin/pg_restore.exe',['-h',url.hostname,'-p',url.port||'5432','-U',decodeURIComponent(url.username),'-d',banco,'--exit-on-error',path.join(source,checkpoint,'banco.dump')],{env,encoding:'utf8'});
 if(restore.status!==0)throw Error('Restauração do clone falhou: '+restore.stderr);
 url.pathname='/'+banco;env.DATABASE_URL=url.toString();delete env.PGPASSWORD;
 console.log('Clone restaurado:',banco);
 const scripts=process.argv.slice(2);if(!scripts.length)scripts.push('migration-015.integration.cjs','alteracao-financeira.integration.cjs','movimentos-015.integration.cjs');
 const results=[];
 for(const script of scripts){if(!/^[a-z0-9.-]+\.cjs$/.test(script))throw Error('Runner inválido');console.log('TESTE',script);const r=cp.spawnSync(process.execPath,[path.join('scripts',script)],{cwd:root,env,encoding:'utf8',maxBuffer:8*1024*1024,timeout:240000});const log=path.join('.tmp','015-'+script+'.log');fs.writeFileSync(path.join(root,log),(r.stdout??'')+(r.stderr??''));results.push({script,status:r.status,log});fs.writeFileSync(path.join(root,'.tmp/015-bateria-resultados.json'),JSON.stringify({banco,results,migrationSha256:createHash('sha256').update(fs.readFileSync(path.join(root,'database/migrations/20260910_015_tratamento_financeiro.sql'))).digest('hex')},null,2));console.log(r.stdout);if(r.status!==0){console.error(r.stderr);throw Error('Falhou: '+script);}}
 console.log('PASS: bateria isolada; clone preservado para inspeção:',banco);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
