/* eslint-disable @typescript-eslint/no-require-imports */
// Gera a partir de pg_get_functiondef; alterações SQL somente em clone novo e registrado.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{spawnSync}=require('node:child_process'),{Client}=require('pg');
const {estruturaFesta016Sql,tabelasFesta016,assinaturaEstruturaFesta016}=require('../lib/festas/estrutura-016.ts');
const sha=x=>createHash('sha256').update(x).digest('hex');
const canonica='d723f81def59be627132230aa6de2e00b0b509d48f20b0e0701afd7eb99650d7';
const corrompida='f4ed68abf6e44dffb643cc618f0a22561c39e717e5637e032bab175019e43f55';
const nomes=['festa016_bloquear_filho_invalidada','festa016_imutavel','festa016_invalidacao','festa016_validar_vinculo','kidmais_proteger_fechamento_em_revisao','kidmais_validar_revisao_operacional'];
const out='.local-festa/reparo-encoding-016',repair='database/repairs/20260911_016_reparar_encoding_funcoes.sql';
async function assinatura(c){return (await c.query(estruturaFesta016Sql,[tabelasFesta016])).rows[0].assinatura;}
async function main(){
 assert.equal(assinaturaEstruturaFesta016,canonica);
 const protegidos=['database/migrations/20260911_016_festa.sql','database/rollback/20260911_016_festa_down.sql','lib/festas/estrutura-016.ts','lib/festas/ambiente.ts'];
 const antes=Object.fromEntries(protegidos.map(p=>[p,sha(fs.readFileSync(p))]));
 const registry=JSON.parse(fs.readFileSync('.local-festa/environments.json'));
 const source=JSON.parse(fs.readFileSync('.local-festa/results/migration.json')).clone;
 assert(registry.automated.includes(source));assert.notEqual(source,registry.manual);assert.match(source,/^kidmais_016_\d+$/);
 const url=new URL(process.env.DATABASE_URL);assert(registry.automated.includes(url.pathname.slice(1)),'Execute com clone.env');url.pathname='/'+source;
 const reader=new Client({connectionString:url.toString(),options:'-c default_transaction_read_only=on'});await reader.connect();let defs;
 try{assert.equal((await reader.query('SELECT current_database() n')).rows[0].n,source);assert.equal(await assinatura(reader),canonica);
  defs=(await reader.query("SELECT p.proname,pg_get_function_identity_arguments(p.oid) argumentos,pg_get_functiondef(p.oid) definicao FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY p.proname",[nomes])).rows;
  assert.equal(defs.length,6);assert.deepEqual(defs.map(d=>d.proname),nomes);assert(defs.every(d=>d.argumentos===''));
 }finally{await reader.end();}
 fs.mkdirSync(out,{recursive:true});fs.mkdirSync(path.dirname(repair),{recursive:true});
 fs.writeFileSync(out+'/fonte-canonica.json',JSON.stringify({clone:source,assinatura:canonica,funcoes:defs.map(d=>({...d,sha256:sha(d.definicao)})),protegidos:antes},null,2));
 const literal='ARRAY['+tabelasFesta016.map(n=>"'"+n+"'").join(',')+']::text[]';
 const query=estruturaFesta016Sql.replaceAll('$1::text[]',literal);
 const guard=final=>`DO $guarda_reparo_016$\nDECLARE atual text;\nBEGIN\n SELECT assinatura INTO atual FROM (${query}) AS assinatura_016;\n IF ${final?`atual IS DISTINCT FROM '${canonica}'`:`atual IS NULL OR atual NOT IN ('${canonica}','${corrompida}')`} THEN\n  RAISE EXCEPTION '${final?'Reparo 016 recusado: assinatura final nao canonica':'Reparo 016 recusado: divergencia inicial nao prevista'}' USING ERRCODE='23514';\n END IF;\nEND\n$guarda_reparo_016$;\n`;
 const sql='-- Reparo operacional 016; nao e migration. Arquivo UTF-8 sem BOM.\n-- Fonte exclusiva: pg_get_functiondef do clone canonico '+source+'.\n-- Executar futuramente com psql -X -v ON_ERROR_STOP=1 -f e PGCLIENTENCODING=UTF8.\n-- Nao autorizado no banco real nesta etapa. Nao enviar por pipeline de texto.\nBEGIN;\nSET LOCAL client_encoding = \'UTF8\';\nSET LOCAL search_path = public;\n'+guard(false)+'\n-- INICIO DEFINICOES CANONICAS\n'+defs.map(d=>d.definicao+';\n').join('\n')+'\n-- FIM DEFINICOES CANONICAS\n'+guard(true)+'COMMIT;\n';
 assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/g)||[]).length,6);
 if(fs.existsSync(repair))assert.equal(fs.readFileSync(repair,'utf8'),sql,'Reparo existente difere: revisar antes de substituir');else fs.writeFileSync(repair,sql,'utf8');
 // Clone novo: nenhuma conexão de escrita ao banco real nem ao clone manual.
 const name='kidmais_repair_016_'+Date.now();assert.match(name,/^kidmais_repair_016_\d+$/);
 const admin=new Client({connectionString:url.toString()});await admin.connect();try{assert.equal((await admin.query('SELECT current_database() n')).rows[0].n,source);await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${source}"`);}finally{await admin.end();}
 registry.automated.push(name);fs.writeFileSync('.local-festa/environments.json',JSON.stringify(registry,null,2));url.pathname='/'+name;
 const c=new Client({connectionString:url.toString()});await c.connect();
 const results={fonte:source,cloneTeste:name,canonica,corrompida,testes:{},protegidos:antes};
 try{
  assert.equal((await c.query('SELECT current_database() n')).rows[0].n,name);
  const tables=(await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename);
  const dados=async()=>{const h={};for(const t of tables){assert.match(t,/^[a-z_]+$/);h[t]=sha(JSON.stringify((await c.query(`SELECT to_jsonb(t)::text linha FROM "${t}" t ORDER BY to_jsonb(t)::text`)).rows));}return h;};
  const dadosAntes=await dados();
  function psql(file,encoding='UTF8',ok=true){
   assert(registry.automated.includes(name));assert.notEqual(name,registry.manual);assert.notEqual(name,'kidmais_manager');
   const r=spawnSync('C:/Program Files/PostgreSQL/18/bin/psql.exe',['-X','-v','ON_ERROR_STOP=1','-h',url.hostname,'-p',url.port||'5432','-U',decodeURIComponent(url.username),'-d',name,'-f',path.resolve(file)],{env:{...process.env,PGPASSWORD:decodeURIComponent(url.password),PGCLIENTENCODING:encoding},encoding:'utf8',windowsHide:true,timeout:30000});
   fs.appendFileSync(out+'/psql.log',JSON.stringify({file,encoding,status:r.status})+'\n'+(r.stdout||'')+(r.stderr||''));
   if(ok)assert.equal(r.status,0,r.stderr||r.error?.message);else{assert.notEqual(r.status,0);assert.match(r.stderr,/Reparo 016 recusado/);}return r;
  }
  fs.writeFileSync(out+'/psql.log','');
  assert.equal(await assinatura(c),canonica);psql(repair);assert.equal(await assinatura(c),canonica);results.testes.A='PASS: canonico permanece canonico';
  // Reproduzir o erro de transporte: arquivo UTF8 lido pelo psql como WIN1252.
  const transport=out+'/somente-clone-reproduzir.sql';fs.writeFileSync(transport,defs.map(d=>d.definicao+';\n').join('\n'),'utf8');psql(transport,'WIN1252');assert.equal(await assinatura(c),corrompida);
  const damaged=(await c.query("SELECT p.proname,pg_get_functiondef(p.oid) definicao FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY p.proname",[nomes])).rows;
  fs.writeFileSync(out+'/reproducao-win1252.json',JSON.stringify(damaged,null,2));
  // Forçar falha final após as substituições: conexão psql encerra sem COMMIT e desfaz tudo.
  const failFinal=out+'/somente-clone-falha-final.sql';fs.writeFileSync(failFinal,sql.replace("RAISE EXCEPTION 'Histórico Festa é imutável'", "RAISE EXCEPTION 'Mensagem adulterada no teste'"),'utf8');
  psql(failFinal,'UTF8',false);assert.equal(await assinatura(c),corrompida);results.testes.falhaFinal='PASS: substituicoes desfeitas automaticamente sem commit';
  psql(repair);assert.equal(await assinatura(c),canonica);psql('database/checks/20260911_016_postcheck.sql');results.testes.B='PASS: WIN1252 reproduz hash real; reparo UTF8 restaura hash canonico; postcheck aprovado';
  // Regra lógica alterada em uma das próprias seis funções: guarda inicial deve impedir mascaramento.
  const original=defs.find(d=>d.proname==='festa016_invalidacao').definicao;
  const altered=original.replace("TG_OP='DELETE'","TG_OP='INSERT'");assert.notEqual(altered,original);await c.query(altered);const logicalHash=await assinatura(c);assert(![canonica,corrompida].includes(logicalHash));
  const reject=psql(repair,'UTF8',false);assert.match(reject.stderr,/divergencia inicial nao prevista/);assert.equal(await assinatura(c),logicalHash);results.testes.C='PASS: alteracao logica recusada antes das substituicoes e mantida intacta';
  // Restaurar exclusivamente a fixture do clone à definição capturada, sem executar rollback de migration.
  await c.query(original);assert.equal(await assinatura(c),canonica);
  // SET LOCAL UTF8 do arquivo também protege quando o cliente inicia com WIN1252.
  psql(repair,'WIN1252');assert.equal(await assinatura(c),canonica);results.testes.encodingExplicito='PASS: SET LOCAL UTF8 impede reincidencia mesmo com cliente inicialmente WIN1252';
  assert.deepEqual(await dados(),dadosAntes);results.dados61TabelasIntactos=true;
  const finalDefs=(await c.query("SELECT p.proname,pg_get_function_identity_arguments(p.oid) argumentos,pg_get_functiondef(p.oid) definicao FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY p.proname",[nomes])).rows;assert.deepEqual(finalDefs,defs);results.seisDefinicoesExatamenteCanonicas=true;
  for(const p of protegidos)assert.equal(sha(fs.readFileSync(p)),antes[p],p);
  results.protegidosIntactos=true;results.assinaturaFinal=await assinatura(c);results.repairSha256=sha(fs.readFileSync(repair));results.acessosBancoReal=0;
  fs.writeFileSync(out+'/resultados.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
 }finally{await c.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
