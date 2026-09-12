/* eslint-disable @typescript-eslint/no-require-imports */
const fs=require('fs'),assert=require('assert/strict'),{createHash}=require('crypto'),{spawnSync}=require('child_process'),{Client}=require('pg');
const digest=v=>createHash('sha256').update(v).digest('hex');
async function main(){
 const state=JSON.parse(fs.readFileSync('.local-festa/checkpoint.json')),dump=state.backup+'/database.dump',migration='database/migrations/20260911_016_festa.sql';
 assert.equal(digest(fs.readFileSync(migration)),'3843802812f7a970f8824f3836eef592bf3b565d1721a4ed33c75e5b620774a2');
 if(fs.existsSync('.local-festa/environments.json')){assert(process.argv.includes('--new-revision'),'Use --new-revision para preparar novos bancos preservando os anteriores.');fs.copyFileSync('.local-festa/environments.json','.local-festa/environments-'+Date.now()+'.json');}
 const source=new URL(process.env.DATABASE_URL),admin=new URL(source);admin.pathname='/postgres';
 const real=new Client({connectionString:source.toString(),options:'-c default_transaction_read_only=on'});await real.connect();
 assert.equal((await real.query('select current_database() n')).rows[0].n,state.sourceDatabase);
 const realBefore=digest(JSON.stringify((await real.query('select to_jsonb(u)::text linha from usuarios_administrativos u order by id')).rows));
 assert.equal((await real.query("select count(*) n from pg_tables where schemaname='public'")).rows[0].n,'52');
 assert.equal((await real.query("select to_regclass('public.festas') t")).rows[0].t,null);await real.end();
 const timestamp=Date.now(),manual='kidmais_016_'+timestamp,automated='kidmais_016_'+(timestamp+1);
 const c=new Client({connectionString:admin.toString()});await c.connect();const reports=[];
 for(const [name,kind] of [[manual,'manual'],[automated,'automated']]){
 await c.query('CREATE DATABASE "'+name+'"');
 const r=spawnSync('C:/Program Files/PostgreSQL/18/bin/pg_restore.exe',['-h',source.hostname,'-p',source.port||'5432','-U',decodeURIComponent(source.username),'--exit-on-error','--no-owner','--no-privileges','-d',name,dump],{env:{...process.env,PGPASSWORD:decodeURIComponent(source.password)},encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 const url=new URL(source);url.pathname='/'+name;const db=new Client({connectionString:url.toString()});await db.connect();
 const tables=(await db.query("select tablename from pg_tables where schemaname='public' order by 1")).rows.map(r=>r.tablename);assert.equal(tables.length,52);
 async function hashes(){const h={};for(const t of tables)h[t]=digest(JSON.stringify((await db.query('select (to_jsonb(t)-ARRAY[$$buffet_lembrancinha$$,$$buffet_empratado$$,$$buffet_bombom$$])::text linha from "'+t+'" t order by (to_jsonb(t)-ARRAY[$$buffet_lembrancinha$$,$$buffet_empratado$$,$$buffet_bombom$$])::text')).rows));return h;}
 const before=await hashes();for(const p of ['database/checks/20260911_016_precheck.sql',migration,'database/checks/20260911_016_postcheck.sql'])await db.query(fs.readFileSync(p,'utf8'));
 assert.deepEqual(await hashes(),before);
 for(const t of (await db.query("select tablename from pg_tables where schemaname='public' and (tablename='festas' or tablename like 'festa_%')")).rows)assert.equal((await db.query('select count(*) n from "'+t.tablename+'"')).rows[0].n,'0');
 const users=(await db.query('select id,nome,papel from usuarios_administrativos order by nome')).rows;
 reports.push({name,kind,users,hashes:before,precheck:true,postcheck:true,semFixtures:true});
 fs.writeFileSync('.local-festa/'+(kind==='manual'?'manual.env':'clone.env'),'DATABASE_URL='+url+'\nFESTA_ENABLED=true\nKIDMAIS_FESTA_ISOLADO=true\nKIDMAIS_FESTA_AMBIENTE='+kind+'\n');
 await db.end();
 }
 await c.end();fs.writeFileSync('.local-festa/environments.json',JSON.stringify({manual,automated:[automated],checkpoint:state.backup,dumpSha256:digest(fs.readFileSync(dump)),realUsersBefore:realBefore},null,2));fs.writeFileSync('.local-festa/results/environments.json',JSON.stringify(reports,null,2));console.log(JSON.stringify(reports.map(({name,kind,users})=>({name,kind,users})),null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
