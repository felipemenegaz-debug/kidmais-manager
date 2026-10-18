/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 084 (etapas duráveis da geração de IA de convites) somente no PostgreSQL do serviço de staging.
// Derivado do da 083. Conferência é read-only; aplicação exige flag própria, hashes revisados, disco persistente,
// identidade Render e o privilégio de DDL em convite_geracoes (ser membro do papel dono): sem ele, para ANTES de escrever.
// Aditiva: o código anterior segue funcionando depois dela; aplicar ANTES do deploy do código que a usa.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {alvo:alvoBase} = require('./migration-078-staging.cjs');
const {SQL_IDENTIDADE, conferirIdentidade, exigirDisco} = require('./conexao-staging.cjs');

const FLAG = '--aplicar-084-autorizado';
const FLAG_CONFERIR = '--conferir-084';
const DIR = '/opt/render/project/src/data/atualizacao-staging-20261018';
const BASE = 'migration-084';
const ETAPAS = Object.freeze([
  ['precheck 084', 'database/checks/20261018_084_precheck.sql', 'd869623076acc546b5cce443b5ad72449465f2e6660269441a1a2e05ae5d1c4c'],
  ['migration 084', 'database/migrations/20261018_084_convite_geracao_pendencias.sql', '1da540fe850119ae96a41e570f3c86eaea1249ef1fd11ece51538ed930630f2e'],
  ['postcheck 084', 'database/checks/20261018_084_postcheck.sql', 'b9ef2e59fcbce0e4218d73f6d4d9a2ae2ad833a7c8b00eadedcc90fb764dec5b'],
]);
// Contagens por estado (sem ids) antes e depois: a 084 não pode mudar nenhuma geração existente.
const SQL_SCHEMA = `SELECT
  (SELECT count(*)=7 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes'
    AND column_name IN ('etapas_registradas','enviado_em','recebido_em','resultado_pendente','falha_classe','falha_diagnostico','falha_detalhes'))
  AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.convite_geracoes'::regclass AND conname='convite_geracoes_etapas_consistentes') AS m084,
  coalesce((SELECT pg_has_role(current_user, t.tableowner, 'MEMBER') FROM pg_tables t
    WHERE t.schemaname='public' AND t.tablename='convite_geracoes'), false) AS pode_alterar,
  (SELECT coalesce(jsonb_object_agg(estado, n), '{}'::jsonb) FROM (SELECT estado, count(*) n FROM convite_geracoes GROUP BY estado) e) AS estados`;

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
  assert.equal(typeof schema?.m084, 'boolean', 'SCHEMA_ILEGIVEL');
  // ALTER TABLE exige ser dono (ou membro do papel dono) de convite_geracoes: sem isso, nada é escrito.
  if (!schema.m084) assert.equal(schema.pode_alterar, true, 'SEM_PRIVILEGIO_DDL');
  return ETAPAS.filter(([nome]) => !schema.m084 || nome==='postcheck 084').map(([nome])=>nome);
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
  const n=fs.readdirSync(dir).filter(x=>/^conferencia-084-\d+\.json$/.test(x)).length+1;
  const arquivo=`conferencia-084-${n}.json`, r={inicio:new Date().toISOString(),modo:'conferencia'};
  const db=new Client(opts);
  try {
    await db.connect(); r.conexao=conferirIdentidade((await db.query(SQL_IDENTIDADE)).rows[0],env);
    r.schema=(await db.query(SQL_SCHEMA)).rows[0];
    await db.query('BEGIN TRANSACTION READ ONLY');
    try {
      if (r.schema.m084) { const post=lerRevisado(raiz,ETAPAS[2][1],ETAPAS[2][2]); await db.query(post); r.postcheck='PASS'; }
      else { r.estadosPrecheck=linhasDe(await db.query(pre)); r.precheck='PASS'; }
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
      if(nome==='precheck 084'||nome==='postcheck 084') {
        await db.query('BEGIN TRANSACTION READ ONLY');
        try { await db.query(sql); await db.query('COMMIT'); } catch(e) { await db.query('ROLLBACK').catch(()=>{}); throw e; }
      } else await db.query(sql);
      Object.assign(r.etapas.at(-1),{ok:true,fim:new Date().toISOString()}); salvar();
    }
    r.schemaDepois=(await db.query(SQL_SCHEMA)).rows[0]; assert.ok(r.schemaDepois.m084,'SCHEMA_DEPOIS');
    // Nenhuma geração muda de estado com a 084 (a 2c911441… continua INCERTA).
    assert.deepEqual(r.schemaDepois.estados,r.schemaAntes.estados,'ESTADOS_ALTERADOS');
    r.concluido=true; salvar(); return {resultado:'PASS',arquivo:tentativa.arquivo,conexao:r.conexao,schemaAntes:r.schemaAntes,schemaDepois:r.schemaDepois,etapas:r.etapas.map(e=>({nome:e.nome,ok:e.ok}))};
  } catch(e) {
    await db.query('ROLLBACK').catch(()=>{}); r.falha={etapa:r.etapas.at(-1)?.nome??'CONEXAO',mensagem:String(e?.message).slice(0,160)}; r.concluido=false; salvar();
    return {resultado:'FALHA',arquivo:tentativa.arquivo,falha:r.falha};
  } finally { await db.end().catch(()=>{}); }
}

if(require.main===module) {
  const argv=process.argv.slice(2);
  if(conferencia(argv)) conferir({env:process.env}).then(s=>{(s.resultado==='CONFERIDO'?console.log:console.error)(JSON.stringify(s));if(s.resultado!=='CONFERIDO')process.exitCode=2;}).catch(e=>{console.error(String(e?.message??'RECUSADO').slice(0,120));process.exitCode=1;});
  else if(!autorizado(argv)){console.error('AGUARDANDO_AUTORIZACAO_084');process.exitCode=1;}
  else executar({env:process.env}).then(s=>{(s.resultado==='PASS'?console.log:console.error)(JSON.stringify(s));if(s.resultado!=='PASS')process.exitCode=2;}).catch(e=>{console.error(String(e?.message??'RECUSADO').slice(0,120));process.exitCode=1;});
}
module.exports={ETAPAS,FLAG,FLAG_CONFERIR,SQL_SCHEMA,alvo,autorizado,conferencia,lerRevisado,planoEtapas,arquivosTentativas,avaliarTentativas,conferir,executar};
