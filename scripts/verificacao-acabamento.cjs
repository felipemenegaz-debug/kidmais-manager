/* eslint-disable @typescript-eslint/no-require-imports */
// Somente leitura no banco local e nos arquivos; relatório em .tmp.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {Client}=require('pg');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(){
 const {dest}=JSON.parse(fs.readFileSync('.tmp/checkpoint-acabamento.json'));
 assert.match(dest,/^\.backups\/acabamento-\d+$/);
 const baseline=JSON.parse(fs.readFileSync(dest+'/dados.json'));
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 const atual={};try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 for(const t of Object.keys(baseline)){assert.match(t,/^[a-z_]+$/);const rows=(await c.query(`SELECT to_jsonb(t)::text AS row FROM public."${t}" t ORDER BY to_jsonb(t)::text`)).rows;atual[t]={count:rows.length,sha256:sha(JSON.stringify(rows))};}
 const catalogo={columns:(await c.query("SELECT table_name,column_name,data_type,column_default,is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows,constraints:(await c.query("SELECT conrelid::regclass::text AS tabela,conname,pg_get_constraintdef(oid) AS definicao FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1,2")).rows,triggers:(await c.query("SELECT tgrelid::regclass::text AS tabela,pg_get_triggerdef(oid) AS definicao FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1,2")).rows};
 assert.deepEqual(catalogo,JSON.parse(fs.readFileSync(dest+'/catalogo.json')),'Estrutura física deve permanecer intacta');await c.query('COMMIT');}finally{await c.end();}
 const divergencias=Object.keys(baseline).filter(t=>JSON.stringify(atual[t])!==JSON.stringify(baseline[t]));
 const old=new Map(JSON.parse(fs.readFileSync(dest+'/manifesto.json')).map(x=>[x.path,x.sha256]));
 const protegidos=[];for(const [p,h] of old){if(/schema_mvp_kidmais\.sql$|database\/migrations\/|^\.env.local$|^next.config.ts$|^next-env.d.ts$|^data\//.test(p)){assert.equal(sha(fs.readFileSync(p)),h,'Arquivo protegido alterado: '+p);protegidos.push(p);}}
 const arquivos=[];function walk(dir=''){for(const e of fs.readdirSync(dir||'.',{withFileTypes:true})){if(['node_modules','.next','.tmp','.backups','.git'].includes(e.name))continue;const p=path.join(dir,e.name).replaceAll('\\','/');if(e.isDirectory())walk(p);else if(!p.endsWith('.tsbuildinfo') && sha(fs.readFileSync(p))!==old.get(p))arquivos.push({path:p,status:old.has(p)?'alterado':'novo'});}}walk();
 fs.writeFileSync('.tmp/verificacao-acabamento.json',JSON.stringify({checkpoint:dest,tabelas:atual,divergencias,estruturaFisicaPreservada:true,protegidos,arquivos},null,2));
 console.log(JSON.stringify({tabelasConferidas:Object.keys(atual).length,divergencias,estruturaFisicaPreservada:true,arquivos,protegidos:protegidos.length},null,2));
 assert.deepEqual(divergencias,[],'Investigar diferenças do banco local antes de concluir');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
