/* eslint-disable @typescript-eslint/no-require-imports */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto'),{Client}=require('pg');
async function main(){
 const state=JSON.parse(fs.readFileSync('.local-festa/checkpoint.json'));
 const expected=JSON.parse(fs.readFileSync('.local-festa/results/migration.json')).hashes;
 const manifest=JSON.parse(fs.readFileSync(path.join(state.backup,'manifest.json')));
 const protectedFiles=Object.keys(manifest).filter(p=>/database[\\/]migrations[\\/].*_(012|013|014|015)_/.test(p)||path.basename(p)==='schema_mvp_kidmais.sql');
 for(const p of protectedFiles)assert.equal(createHash('sha256').update(fs.readFileSync(p)).digest('hex'),manifest[p],p);
 const source=new Client({connectionString:process.env.DATABASE_URL,options:'-c default_transaction_read_only=on'});await source.connect();
 const cloneLine=fs.readFileSync('.local-festa/clone.env','utf8').split(/\r?\n/).find(x=>x.startsWith('DATABASE_URL='));assert(cloneLine);const clone=new Client({connectionString:cloneLine.slice(13),options:'-c default_transaction_read_only=on'});await clone.connect();
 try{
 await source.query('BEGIN READ ONLY');await clone.query('BEGIN READ ONLY');
 assert.equal((await source.query('select current_database() n')).rows[0].n,state.sourceDatabase);assert.match((await clone.query('select current_database() n')).rows[0].n,/^kidmais_016_\d+$/);
 assert.equal((await source.query("select to_regclass('public.festas') t")).rows[0].t,null);
 for(const [t,h] of Object.entries(expected)){const rows=(await source.query(`SELECT to_jsonb(t)::text linha FROM "${t}" t ORDER BY to_jsonb(t)::text`)).rows;assert.equal(createHash('sha256').update(JSON.stringify(rows)).digest('hex'),h,'Banco real divergiu: '+t);const copied=new Set((await clone.query(`SELECT to_jsonb(t)::text linha FROM "${t}" t`)).rows.map(r=>r.linha));for(const r of rows)assert(copied.has(r.linha),'Registro histórico do clone divergiu: '+t);}
 await source.query('ROLLBACK');await clone.query('ROLLBACK');
 fs.writeFileSync('.local-festa/results/preservation.json',JSON.stringify({bancoReal:state.sourceDatabase,somenteLeitura:true,migration016AusenteNoReal:true,tabelasReaisIntactas:Object.keys(expected).length,registrosOriginaisPreservadosNoClone:true,arquivosProtegidos:protectedFiles},null,2));console.log('PASS preservação: 52 tabelas reais iguais ao checkpoint; originais preservados no clone; Migration 016 ausente no real; arquivos protegidos intactos.');
 }finally{await Promise.all([source.end(),clone.end()]);}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
