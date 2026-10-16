/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 083 (WhatsApp por empresa) somente no PostgreSQL do serviço de staging. Derivado do da 079.
// Conferência é read-only; aplicação exige flag própria, hashes revisados, disco persistente, identidade Render e o
// privilégio de DDL nas duas tabelas da 018 (ser membro do papel dono): sem ele, para ANTES de qualquer escrita.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {alvo:alvoBase} = require('./migration-078-staging.cjs');
const {SQL_IDENTIDADE, conferirIdentidade, exigirDisco} = require('./conexao-staging.cjs');

const FLAG = '--aplicar-083-autorizado';
const FLAG_CONFERIR = '--conferir-083';
const DIR = '/opt/render/project/src/data/atualizacao-staging-20261016';
const BASE = 'migration-083';
const ETAPAS = Object.freeze([
  ['precheck 083', 'database/checks/20261016_083_precheck.sql', 'd48bf23c200eacdddd2ca592c4e3e8b29d2cc3a0de3c08365e82ea92905d8a52'],
  ['migration 083', 'database/migrations/20261016_083_whatsapp_conexao_empresa.sql', '5806c11a3c7d270878d142e5656f26bb4742e83571eedef4190f37eee2e5ceb2'],
  ['postcheck 083', 'database/checks/20261016_083_postcheck.sql', 'def0037f6dcb70bf33c915884d7ebf4232f141654783caee2f913639d474b1a2'],
]);
const SQL_SCHEMA = `SELECT
  (SELECT count(*)=2 FROM information_schema.columns WHERE table_schema='public' AND column_name='empresa_id'
    AND table_name IN ('whatsapp_conexoes','whatsapp_onboarding_tentativas'))
  AND to_regclass('public.whatsapp_conexoes_empresa_configurada_uk') IS NOT NULL
  AND to_regclass('public.whatsapp_conexoes_ambiente_configurada_uk') IS NULL AS m083,
  coalesce((SELECT bool_and(pg_has_role(current_user, t.tableowner, 'MEMBER')) FROM pg_tables t
    WHERE t.schemaname='public' AND t.tablename IN ('whatsapp_conexoes','whatsapp_onboarding_tentativas')), false) AS pode_alterar`;

function alvo(env) {
  const opts=alvoBase(env);
  assert.ok(new URL(opts.connectionString).search === '', 'CONNECTION_QUERY_REJECTED');
  return opts;
}

function lerRevisado(raiz, arquivo, hash) {
  const sql = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(sql, 'utf8').digest('hex'), hash, 'ARQUIVO_DIVERGENTE ' + arquivo);
  return sql;
}
function autorizado(argv) { const f=argv.filter(x=>x.startsWith('--')); return f.length===1 && f[0]===FLAG; }
function conferencia(argv) { const f=argv.filter(x=>x.startsWith('--')); return f.length===1 && f[0]===FLAG_CONFERIR; }
function planoEtapas(schema) {
  assert.equal(typeof schema?.m083, 'boolean', 'SCHEMA_ILEGIVEL');
  // ALTER TABLE exige ser dono (ou membro do papel dono) das tabelas da 018: sem isso, nada é escrito.
  if (!schema.m083) assert.equal(schema.pode_alterar, true, 'SEM_PRIVILEGIO_DDL');
  return ETAPAS.filter(([nome]) => !schema.m083 || nome==='postcheck 083').map(([nome])=>nome);
}
function arquivosTentativas(dir) {
  if (!fs.existsSync(dir)) return [];
  const n=x=>x===BASE+'.json'?1:Number(new RegExp('^'+BASE+'\\.tentativa-(\\d+)\\.json$').exec(x)?.[1]??NaN);
  return fs.readdirSync(dir).filter(x=>Number.isInteger(n(x))).sort((a,b)=>n(a)-n(b));
}
function avaliarTentativas(dir) {
  const anteriores=arquivosTentativas(dir);
  assert.equal(anteriores.length,0,'TENTATIVA_ANTERIOR_REVISAR '+(anteriores[0]??''));
  return {numero:1,arquivo:BASE+'.json'};
}
function linhasDe(resultado) { return (Array.isArray(resultado)?resultado:[resultado]).flatMap(x=>x.rows??[]); }

async function conferir({env,dir=DIR,raiz=path.resolve(__dirname,'..'),Client=require('pg').Client,disco=()=>exigirDisco()}) {
  const opts=alvo(env); disco();
  const pre=lerRevisado(raiz,ETAPAS[0][1],ETAPAS[0][2]);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const n=fs.readdirSync(dir).filter(x=>/^conferencia-083-\d+\.json$/.test(x)).length+1;
  const arquivo=`conferencia-083-${n}.json`, r={inicio:new Date().toISOString(),modo:'conferencia'};
  const db=new Client(opts);
  try {
    await db.connect(); r.conexao=conferirIdentidade((await db.query(SQL_IDENTIDADE)).rows[0],env);
    r.schema=(await db.query(SQL_SCHEMA)).rows[0];
    await db.query('BEGIN TRANSACTION READ ONLY');
    try {
      if (r.schema.m083) { const post=lerRevisado(raiz,ETAPAS[2][1],ETAPAS[2][2]); await db.query(post); r.postcheck='PASS'; }
      else { r.precheck=linhasDe(await db.query(pre)).at(-1)??'PASS'; }
      await db.query('COMMIT');
    } catch(e) { await db.query('ROLLBACK').catch(()=>{}); throw e; }
    r.resultado='CONFERIDO';
  } catch(e) { await db.query('ROLLBACK').catch(()=>{}); r.resultado='FALHA'; r.mensagem=String(e?.message).slice(0,160); }
  finally { await db.end().catch(()=>{}); }
  fs.writeFileSync(path.join(dir,arquivo),JSON.stringify(r,null,2),{mode:0o600,flag:'wx'});
  return {...r,arquivo};
}

async function executar({env,dir=DIR,raiz=path.resolve(__dirname,'..'),Client=require('pg').Client,disco=()=>exigirDisco()}) {
  const opts=alvo(env); disco();
  const sqls=new Map(ETAPAS.map(([nome,arquivo,hash])=>[nome,lerRevisado(raiz,arquivo,hash)]));
  fs.mkdirSync(dir,{recursive:true,mode:0o700}); const tentativa=avaliarTentativas(dir);
  const arquivo=path.join(dir,tentativa.arquivo),r={inicio:new Date().toISOString(),tentativa:tentativa.numero,etapas:[]};
  fs.writeFileSync(arquivo,JSON.stringify(r,null,2),{mode:0o600,flag:'wx'});
  const salvar=()=>fs.writeFileSync(arquivo,JSON.stringify(r,null,2),{mode:0o600});
  const db=new Client(opts);
  try {
    await db.connect(); r.conexao=conferirIdentidade((await db.query(SQL_IDENTIDADE)).rows[0],env); salvar();
    r.schemaAntes=(await db.query(SQL_SCHEMA)).rows[0]; r.plano=planoEtapas(r.schemaAntes); salvar();
    for(const nome of r.plano) {
      r.etapas.push({nome,inicio:new Date().toISOString()}); salvar();
      const sql=sqls.get(nome);
      if(nome==='precheck 083'||nome==='postcheck 083') {
        await db.query('BEGIN TRANSACTION READ ONLY');
        try { await db.query(sql); await db.query('COMMIT'); } catch(e) { await db.query('ROLLBACK').catch(()=>{}); throw e; }
      } else await db.query(sql);
      Object.assign(r.etapas.at(-1),{ok:true,fim:new Date().toISOString()}); salvar();
    }
    r.schemaDepois=(await db.query(SQL_SCHEMA)).rows[0]; assert.ok(r.schemaDepois.m083,'SCHEMA_DEPOIS');
    r.concluido=true; salvar(); return {resultado:'PASS',arquivo:tentativa.arquivo,conexao:r.conexao,schemaAntes:r.schemaAntes,schemaDepois:r.schemaDepois,etapas:r.etapas.map(e=>({nome:e.nome,ok:e.ok}))};
  } catch(e) {
    await db.query('ROLLBACK').catch(()=>{}); r.falha={etapa:r.etapas.at(-1)?.nome??'CONEXAO',mensagem:String(e?.message).slice(0,160)}; r.concluido=false; salvar();
    return {resultado:'FALHA',arquivo:tentativa.arquivo,falha:r.falha};
  } finally { await db.end().catch(()=>{}); }
}

if(require.main===module) {
  const argv=process.argv.slice(2);
  if(conferencia(argv)) conferir({env:process.env}).then(s=>{(s.resultado==='CONFERIDO'?console.log:console.error)(JSON.stringify(s));if(s.resultado!=='CONFERIDO')process.exitCode=2;}).catch(e=>{console.error(String(e?.message??'RECUSADO').slice(0,120));process.exitCode=1;});
  else if(!autorizado(argv)){console.error('AGUARDANDO_AUTORIZACAO_083');process.exitCode=1;}
  else executar({env:process.env}).then(s=>{(s.resultado==='PASS'?console.log:console.error)(JSON.stringify(s));if(s.resultado!=='PASS')process.exitCode=2;}).catch(e=>{console.error(String(e?.message??'RECUSADO').slice(0,120));process.exitCode=1;});
}
module.exports={ETAPAS,FLAG,FLAG_CONFERIR,SQL_SCHEMA,alvo,autorizado,conferencia,lerRevisado,planoEtapas,arquivosTentativas,avaliarTentativas,conferir,executar};
