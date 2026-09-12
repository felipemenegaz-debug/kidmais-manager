/* eslint-disable @typescript-eslint/no-require-imports */
require('./festa-016-test-environment.cjs').assertAutomated();
/* eslint-disable @typescript-eslint/no-require-imports */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{Client}=require('pg');
async function main(){
 const source=new URL(process.env.DATABASE_URL);assert.match(source.pathname,/^\/kidmais_016_\d+$/);
 const state=JSON.parse(fs.readFileSync('.local-festa/checkpoint.json')),dump=path.join(state.backup,'database.dump');assert(fs.existsSync(dump));
 const name='kidmais_016_'+Date.now(),c=new Client({connectionString:source.toString()});await c.connect();assert.match((await c.query('select current_database() n')).rows[0].n,/^kidmais_016_\d+$/);await c.query('CREATE DATABASE "'+name+'"');await c.end();
 const env={...process.env,PGPASSWORD:decodeURIComponent(source.password)},args=['-h',source.hostname,'-p',source.port||'5432','-U',decodeURIComponent(source.username)];
 assert.equal(spawnSync('C:/Program Files/PostgreSQL/18/bin/pg_restore.exe',[...args,'--exit-on-error','--no-owner','--no-privileges','-d',name,dump],{env}).status,0);
 const registry=JSON.parse(fs.readFileSync('.local-festa/environments.json'));registry.automated.push(name);fs.writeFileSync('.local-festa/environments.json',JSON.stringify(registry,null,2));source.pathname='/'+name;const r=spawnSync(process.execPath,['scripts/migration-016.integration.cjs'],{env:{...process.env,DATABASE_URL:source.toString()},encoding:'utf8'});console.log(r.stdout,r.stderr);assert.equal(r.status,0);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
