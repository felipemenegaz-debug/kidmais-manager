/* eslint-disable @typescript-eslint/no-require-imports */
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{spawnSync}=require('child_process'),{createHash}=require('crypto'),{Client}=require('pg');
const digest=v=>createHash('sha256').update(v).digest('hex');
async function main(){
 const registry=JSON.parse(fs.readFileSync('.local-festa/environments.json')),baseline=JSON.parse(fs.readFileSync('.local-festa/results/environments.json')).find(x=>x.kind==='manual');
 const source=new URL(process.env.DATABASE_URL);assert.equal(source.pathname,'/kidmais_manager');
 const manual=new URL(source);manual.pathname='/'+registry.manual;
 const guards=fs.readdirSync('scripts').filter(n=>n.endsWith('.cjs')&&n!=='festa-016-test-environment.cjs'&&n!=='festa-016-verify-environments.cjs'&&fs.readFileSync('scripts/'+n,'utf8').includes("require('./festa-016-test-environment.cjs').assertAutomated();"));
 for(const script of guards){const r=spawnSync(process.execPath,['scripts/'+script],{env:{...process.env,DATABASE_URL:manual.toString()},encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/clone manual está protegido/);}
 const c=new Client({connectionString:manual.toString(),options:'-c default_transaction_read_only=on'});await c.connect();await c.query('BEGIN READ ONLY');
 for(const [table,expected] of Object.entries(baseline.hashes)){const rows=(await c.query('select (to_jsonb(t)-ARRAY[$$buffet_lembrancinha$$,$$buffet_empratado$$,$$buffet_bombom$$])::text linha from "'+table+'" t order by (to_jsonb(t)-ARRAY[$$buffet_lembrancinha$$,$$buffet_empratado$$,$$buffet_bombom$$])::text')).rows;assert.equal(digest(JSON.stringify(rows)),expected,table);}
 const tables=(await c.query("select tablename from pg_tables where schemaname='public'")).rows;assert.equal(tables.length,61);
 for(const {tablename} of tables.filter(x=>x.tablename==='festas'||x.tablename.startsWith('festa_')))assert.equal((await c.query('select count(*) n from "'+tablename+'"')).rows[0].n,'0');
 const users=(await c.query('select id,nome,papel from usuarios_administrativos order by nome')).rows;assert.deepEqual(users,baseline.users);await c.query('ROLLBACK');await c.end();
 const real=new Client({connectionString:source.toString(),options:'-c default_transaction_read_only=on'});await real.connect();await real.query('BEGIN READ ONLY');
 assert.equal((await real.query("select count(*) n from pg_tables where schemaname='public'")).rows[0].n,'52');assert.equal((await real.query("select to_regclass('public.festas') t")).rows[0].t,null);
 assert.equal(digest(JSON.stringify((await real.query('select to_jsonb(u)::text linha from usuarios_administrativos u order by id')).rows)),registry.realUsersBefore);await real.query('ROLLBACK');await real.end();
 const hash=digest(fs.readFileSync('database/migrations/20260911_016_festa.sql'));assert.equal(hash,'3843802812f7a970f8824f3836eef592bf3b565d1721a4ed33c75e5b620774a2');
 const state=JSON.parse(fs.readFileSync('.local-festa/checkpoint.json')),manifest=JSON.parse(fs.readFileSync(path.join(state.backup,'manifest.json')));for(const [p,h] of Object.entries(manifest))if(/database[\\/]migrations[\\/].*_(012|013|014|015)_/.test(p)||path.basename(p)==='schema_mvp_kidmais.sql')assert.equal(digest(fs.readFileSync(p)),h,p);
 fs.writeFileSync('.local-festa/results/isolation.json',JSON.stringify({manual:registry.manual,usuarios:users,fixturesRecusadas:guards,manual52TabelasPreservadas:true,novas9TabelasVazias:true,bancoReal52Sem016:true,usuariosReaisIntactos:true,hash016:hash},null,2));
 console.log('PASS isolamento: '+guards.length+' runners recusam clone manual; 52 tabelas preservadas; 9 vazias; único usuário Felipe; banco real com 52 tabelas, sem 016 e usuários intactos.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

