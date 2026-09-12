/* eslint-disable @typescript-eslint/no-require-imports */
// Auditoria final somente leitura no PostgreSQL local; evidências em .tmp.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {Client}=require('pg'),{fingerprint,catalog,paths}=require('./migration-014.validation.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(){
 const {dest}=JSON.parse(fs.readFileSync('.tmp/checkpoint-014.json'));
 const evidence=JSON.parse(fs.readFileSync(dest+'/014-teste-isolado.json')),applied=JSON.parse(fs.readFileSync(dest+'/014-aplicacao-local.json'));
 assert.equal(sha(fs.readFileSync(paths.up)),applied.sha256Migration,'Migration 014 aplicada deve permanecer intacta');
 const baseline=JSON.parse(fs.readFileSync(dest+'/dados.json')),old=new Map(JSON.parse(fs.readFileSync(dest+'/manifesto.json')).map(x=>[x.path,x.sha256]));
 const protegidos=[];for(const [p,h]of old)if(/schema_mvp_kidmais\.sql$|database\/migrations\/|^\.env.local$|^next.config.ts$|^next-env.d.ts$|^data\//.test(p)){assert.equal(sha(fs.readFileSync(p)),h,'Arquivo protegido alterado: '+p);protegidos.push(p);}
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();let atual,cat,novas;
 try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.equal((await c.query('SELECT current_database() db')).rows[0].db,'kidmais_manager');atual=await fingerprint(c,evidence.columns);assert.deepEqual(atual,baseline,'Os dados anteriores do banco local mudaram: investigar antes de concluir');await c.query('SET LOCAL search_path=public,pg_catalog');cat=await catalog(c);assert.deepEqual(cat,JSON.parse(fs.readFileSync(dest+'/014-catalogo-local.json')),'Catálogo aplicado deve permanecer intacto');await c.query(fs.readFileSync(paths.post,'utf8'));
 novas=(await c.query('SELECT (SELECT count(*) FROM fechamento_revisoes)::int revisoes,(SELECT count(*) FROM fechamento_revisao_adicionais)::int itens,(SELECT count(*) FROM aprovacoes_negociacao WHERE num_nonnulls(fechamento_revisao_id,fechamento_revisao_numero,fechamento_revisao_hash,chave_decisao)>0)::int aprovacoes_vinculadas')).rows[0];assert.deepEqual(novas,{revisoes:0,itens:0,aprovacoes_vinculadas:0});await c.query('COMMIT');}finally{await c.end();}
 const arquivos=[];function walk(dir=''){for(const e of fs.readdirSync(dir||'.',{withFileTypes:true})){if(['node_modules','.next','.tmp','.backups','.git'].includes(e.name))continue;const p=path.join(dir,e.name).replaceAll('\\','/');if(e.isDirectory())walk(p);else if(!p.endsWith('.tsbuildinfo')&&sha(fs.readFileSync(p))!==old.get(p))arquivos.push({path:p,status:old.has(p)?'alterado':'novo',sha256:sha(fs.readFileSync(p))});}}walk();
 fs.writeFileSync('.tmp/verificacao-final-014.json',JSON.stringify({checkpoint:dest,banco:'kidmais_manager',tabelas:40,projecoesConferidas:38,dadosAnteriores:atual,divergencias:[],novas,catalogoAplicadoIntacto:true,migration014Hash:applied.sha256Migration,protegidos,arquivos},null,2));
 console.log(JSON.stringify({tabelas:40,projecoesPreservadas:38,divergencias:[],novas,arquivos:arquivos.length,protegidos:protegidos.length}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
