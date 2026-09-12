/* eslint-disable @typescript-eslint/no-require-imports */
require('./festa-016-test-environment.cjs').assertAutomated();
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {Client} = require('pg');
async function main() {
 const c = new Client({connectionString:process.env.DATABASE_URL});
 await c.connect();
 try {
  const name = (await c.query('SELECT current_database() nome')).rows[0].nome;
  assert.match(name,/^kidmais_016_\d+$/,'Recusado: use somente clone 016');
  const tables = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows.map(r=>r.tablename);
  assert.equal(tables.length,52);
  async function hashes(){const h={};for(const t of tables)h[t]=createHash('sha256').update(JSON.stringify((await c.query(`SELECT (to_jsonb(t)-ARRAY[$$buffet_lembrancinha$$,$$buffet_empratado$$,$$buffet_bombom$$])::text linha FROM "${t}" t ORDER BY (to_jsonb(t)-ARRAY[$$buffet_lembrancinha$$,$$buffet_empratado$$,$$buffet_bombom$$])::text`)).rows)).digest('hex');return h;}
  const before=await hashes();
  const functions=async()=>(await c.query("SELECT proname,pg_get_functiondef(oid) definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('kidmais_hash_revisao_operacional','kidmais_validar_revisao_operacional','kidmais_proteger_fechamento_em_revisao') ORDER BY proname")).rows;
  const functionsBefore=await functions();
  const structure=async()=>{
   const queries={
    tabelas:"SELECT relname,relkind,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','S','v') ORDER BY relname",
    colunas:"SELECT r.relname,a.attname,format_type(a.atttypid,a.atttypmod) tipo,a.attnotnull,a.attidentity,pg_get_expr(d.adbin,d.adrelid) padrao FROM pg_attribute a JOIN pg_class r ON r.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=r.oid AND d.adnum=a.attnum WHERE r.relnamespace='public'::regnamespace AND r.relkind IN ('r','v') AND a.attnum>0 AND NOT a.attisdropped ORDER BY r.relname,a.attname",
    constraints:"SELECT r.relname,c.conname,c.contype,c.convalidated,c.condeferrable,c.condeferred,pg_get_constraintdef(c.oid) definicao FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid WHERE r.relnamespace='public'::regnamespace ORDER BY r.relname,c.conname",
    indices:"SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname",
    triggers:"SELECT r.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definicao FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid WHERE r.relnamespace='public'::regnamespace AND NOT t.tgisinternal ORDER BY r.relname,t.tgname",
    funcoes:"SELECT proname,pg_get_functiondef(oid) definicao FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind IN ('f','p') ORDER BY proname,pg_get_functiondef(oid)"
   };const result={};for(const [k,q]of Object.entries(queries))result[k]=(await c.query(q)).rows;return result;
  };
  const structureBefore=await structure();
  const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const checkpoint={clone:name,estrutura:structureBefore,funcoes:functionsBefore,hashes:before};
  fs.writeFileSync('.local-festa/results/structural-checkpoint.json',JSON.stringify(checkpoint,null,2));


  const sql=async p=>c.query(fs.readFileSync(p,'utf8'));
  const pre='database/checks/20260911_016_precheck.sql',migration='database/migrations/20260911_016_festa.sql',post='database/checks/20260911_016_postcheck.sql',down='database/rollback/20260911_016_festa_down.sql';
  await sql(pre);await sql(migration);await sql(post);assert.equal((await c.query("SELECT count(*) n FROM pg_tables WHERE schemaname='public'")).rows[0].n,'61');assert.deepEqual(await hashes(),before);
  for(const t of ['festas','festa_areas','festa_usuario_capacidades','festa_tarefas','festa_pendencias','festa_buffet','festa_contagens_convidados','festa_solicitacoes','festa_eventos'])assert.equal((await c.query(`SELECT count(*) n FROM ${t}`)).rows[0].n,'0','Sem seed/backfill: '+t);
  await sql(down);assert.deepEqual(await structure(),structureBefore,'Estrutura inteira deve retornar ao checkpoint');assert.deepEqual(await functions(),functionsBefore);assert.deepEqual(await hashes(),before);await sql(pre);await sql(migration);await sql(post);
  await c.query('BEGIN');await c.query("INSERT INTO festa_areas(nome,criado_por) SELECT 'Área temporária teste',id FROM usuarios_administrativos LIMIT 1");await assert.rejects(sql(down),/Rollback recusado/);await c.query('ROLLBACK');
  await c.query('BEGIN');await c.query("UPDATE fechamentos SET buffet_bombom='Preferência teste rollback' WHERE id=(SELECT id FROM fechamentos LIMIT 1)");await assert.rejects(sql(down),/Rollback recusado/);await c.query('ROLLBACK');
  for(const table of ['fechamentos','fechamento_revisoes'])assert.equal((await c.query('SELECT count(*) n FROM '+table+' WHERE buffet_lembrancinha IS NOT NULL OR buffet_empratado IS NOT NULL OR buffet_bombom IS NOT NULL')).rows[0].n,'0');
  assert.deepEqual(await hashes(),before);
  fs.mkdirSync('.local-festa/results',{recursive:true});fs.writeFileSync('.local-festa/results/migration.json',JSON.stringify({clone:name,precheck:true,aplicacao:true,postcheck:true,rollback:true,reaplicacao:true,rollbackComDadosRecusado:true,rollbackComEscolhasRecusado:true,funcoesOriginaisRestauradas:true,estruturaIntegralRestaurada:true,estruturaCheckpointSha256:sha(structureBefore),funcoesAnterioresSha256:Object.fromEntries(functionsBefore.map(f=>[f.proname,sha(f.definition)])),novasColunasNulasSemBackfill:true,tabelasAnterioresIntactas:tables.length,hashes:before},null,2));
  console.log('016: precheck/aplicação/postcheck/rollback/reaplicação PASS; 52 tabelas anteriores intactas; 61 tabelas finais.');
 } finally {await c.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
