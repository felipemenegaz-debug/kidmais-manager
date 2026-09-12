/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicação autorizada: exige evidência isolada, valida o checkpoint e todas as linhas anteriores.
const {Client}=require('pg');
const fs=require('node:fs');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const dir='.backups/pre-013-20260909-183215';
async function fingerprint(c,tables){
 const data={};
 for(const table of tables){assert.match(table,/^[a-z_]+$/);const rows=(await c.query(`SELECT to_jsonb(t)::text AS row FROM public."${table}" t ORDER BY to_jsonb(t)::text`)).rows;data[table]={count:rows.length,sha256:crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')};}
 return data;
}
async function main(){
 const isolated=JSON.parse(fs.readFileSync(dir+'/teste-isolado.json'));
 assert(isolated.results.length>=8,'Validações isoladas incompletas');
 const baseline=JSON.parse(fs.readFileSync(dir+'/dados-antes.json'));
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try{
  assert.equal((await c.query('SELECT current_database() AS name')).rows[0].name,'kidmais_manager');
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
  await c.query('LOCK TABLE '+Object.keys(baseline).sort().map(t=>'public."'+t+'"').join(',')+' IN ACCESS EXCLUSIVE MODE');
  assert.deepEqual(await fingerprint(c,Object.keys(baseline)),baseline,'Banco mudou desde checkpoint; abortar e reinspecionar');
  await c.query(fs.readFileSync('database/checks/20260909_013_precheck.sql','utf8'));
  const up=fs.readFileSync('database/migrations/20260909_013_autenticacao_contrato.sql','utf8').replace(/^BEGIN;\r?\n/m,'').replace(/^COMMIT;\s*$/m,'');
  await c.query(up);await c.query(fs.readFileSync('database/checks/20260909_013_postcheck.sql','utf8'));
  const after=await fingerprint(c,Object.keys(baseline));assert.deepEqual(after,baseline);
  const names=['usuarios_administrativos','sessoes_administrativas','limites_autenticacao','contrato_fluxos','contrato_edicoes','contrato_documentos','contrato_assinaturas','contrato_pendencias_financeiras'];
  for(const name of names)assert.equal((await c.query('SELECT count(*)::int AS n FROM '+name)).rows[0].n,0);
  await c.query('COMMIT');
  fs.writeFileSync(dir+'/aplicacao-local.json',JSON.stringify({banco:'kidmais_manager',aplicada:true,tabelasAnterioresPreservadas:after,novasTabelasVazias:names,sha256Migration:crypto.createHash('sha256').update(fs.readFileSync('database/migrations/20260909_013_autenticacao_contrato.sql')).digest('hex')},null,2));
  console.log(JSON.stringify({aplicada:true,tabelasAnterioresPreservadas:Object.keys(after).length,novasTabelasVazias:names.length}));
 }catch(e){await c.query('ROLLBACK');throw e;}finally{await c.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
