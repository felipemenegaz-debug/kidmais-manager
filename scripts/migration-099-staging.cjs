/* eslint-disable @typescript-eslint/no-require-imports */
// Execução manual autorizada no Web Shell de staging, ANTES do novo código.
// Não aceita alvo arbitrário nem aplica rollback. Sem flag, não conecta.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {SQL_IDENTIDADE, conferirIdentidade, exigirDisco, tlsEsperado} = require('./conexao-staging.cjs');
const ROOT = path.resolve(__dirname, '..');
const DIR = '/opt/render/project/src/data/convites-avulsos-099-staging';
const FILES = [
  'database/checks/20261024_099_precheck.sql',
  'database/migrations/20261024_099_convites_avulsos.sql',
  'database/checks/20261024_099_postcheck.sql',
];
const HASHES = ["9d0932e23fcae892a80daab17040627c1a9cb10a96ded08d995fa0d5738fba51","3cbff37dfd4ad5e2272f7f8989e1f5131197c6244c071402075c0e1aa8c12ee5","1498f16c2129c2572543d38e9704b7fc815c497123da165afb04fe04d9e728c7"]; // preenchidos pelo manifesto revisado antes da execução
function alvo(env) {
  assert.equal(env.RENDER, 'true', 'FORA_DO_RENDER');
  assert.equal(env.RENDER_SERVICE_ID, 'srv-daif418ae00c73e8k2gg', 'SERVICO_RECUSADO');
  assert.equal(env.KIDMAIS_DEPLOY_ENV, 'staging', 'AMBIENTE_RECUSADO');
  let u; try {u = new URL(env.DATABASE_URL);} catch {throw Error('URL_RECUSADA');}
  assert.equal(u.hostname, 'dpg-daidko3m8hqs73ce4jt0-a', 'HOST_RECUSADO');
  assert.equal(decodeURIComponent(u.pathname.slice(1)), 'kidmais_staging_1z91', 'BANCO_RECUSADO');
  assert.ok(!u.port || u.port === '5432', 'PORTA_RECUSADA');
  assert.equal(u.search, '', 'QUERY_RECUSADA');
  return {connectionString: env.DATABASE_URL, ssl: tlsEsperado(env) ? {rejectUnauthorized:true,minVersion:'TLSv1.2'} : undefined,
    connectionTimeoutMillis:10000, application_name:'kidmais-convites-099'};
}
function lerArquivos(root = ROOT) {
  assert.equal(HASHES.length, FILES.length, 'MANIFESTO_AUSENTE');
  return FILES.map((f,i) => {
    const sql = fs.readFileSync(path.join(root,f),'utf8').replaceAll('\r\n','\n');
    assert.equal(createHash('sha256').update(sql).digest('hex'), HASHES[i], 'HASH_RECUSADO_' + i);
    return sql;
  });
}
const semTransacao = sql => sql.split('\n').filter(l => !/^\s*(BEGIN|COMMIT);\s*$/.test(l)).join('\n');
async function conferir(c, sql) {
  await c.query('BEGIN TRANSACTION READ ONLY');
  try {
    await c.query("SET LOCAL statement_timeout='30s'");
    const presente = (await c.query("SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.convites'::regclass AND conname='convite_avulso_vinculo_completo') AS sim")).rows[0].sim;
    await c.query(presente ? sql[2] : sql[0]);
    const r = {estado:presente ? 'APLICADA_POSTCHECK_PASS' : 'AUSENTE_PRECHECK_PASS'};
    await c.query('COMMIT'); return r;
  } catch(e) {await c.query('ROLLBACK'); throw e;}
}
async function aplicar(c, sql, dir = DIR) {
  fs.mkdirSync(dir,{recursive:true});
  const registro = path.join(dir,'registro.json');
  // Marcador exclusivo durável antecede o SQL. Resultado incerto exige conferência, nunca repetição automática.
  const fd = fs.openSync(registro,'wx',0o600);
  const gravar = valor => {fs.ftruncateSync(fd,0); fs.writeSync(fd,JSON.stringify(valor,null,2),0,'utf8'); fs.fsyncSync(fd);};
  let etapa = 'INICIADA', commitEnviado = false;
  try {
    gravar({estado:etapa,hashes:HASHES,inicio:new Date().toISOString()});
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'; SET LOCAL search_path=public,pg_catalog");
    await c.query('SELECT pg_advisory_xact_lock(990024)');
    await c.query('LOCK TABLE convites,convite_ia_autorizacoes IN ACCESS EXCLUSIVE MODE');
    await c.query(sql[0]);
    const retrato = (await c.query(`SELECT
      (SELECT count(*) FROM convites) AS convites,
      (SELECT count(*) FROM convite_ia_autorizacoes) AS autorizacoes,
      pg_get_functiondef('convite_validar_vinculo()'::regprocedure) AS vinculo,
      pg_get_functiondef('convite_ia_autorizacao_validar()'::regprocedure) AS consentimento`)).rows[0];
    fs.writeFileSync(path.join(dir,'estrutura-anterior.json'),JSON.stringify(retrato,null,2),{flag:'wx',mode:0o600});
    etapa = 'EM_TRANSACAO'; gravar({estado:etapa,hashes:HASHES});
    await c.query(semTransacao(sql[1]));
    await c.query(sql[2]);
    const depois = (await c.query('SELECT (SELECT count(*) FROM convites) AS convites,(SELECT count(*) FROM convite_ia_autorizacoes) AS autorizacoes')).rows[0];
    assert.equal(depois.convites,retrato.convites,'CONTAGEM_CONVITES_DIVERGENTE');
    assert.equal(depois.autorizacoes,retrato.autorizacoes,'CONTAGEM_AUTORIZACOES_DIVERGENTE');
    commitEnviado = true;
    await c.query('COMMIT');
    etapa = 'APLICADA_POSTCHECK_PASS';
    const r = {estado:etapa,hashes:HASHES,contagens:depois,fim:new Date().toISOString()};
    gravar(r); return r;
  } catch(e) {
    await c.query('ROLLBACK').catch(()=>{});
    try {gravar({estado:commitEnviado ? 'CONFERIR_COMMIT' : 'FALHA_SEM_COMMIT',etapa,hashes:HASHES});} catch {}
    throw e;
  } finally {fs.closeSync(fd);}
}
async function main() {
  const modo = process.argv[2];
  if (!modo) {console.log('PREPARADO: --conferir-099 ou --aplicar-099-autorizado. Somente staging.'); return;}
  assert.ok(process.argv.length===3 && ['--conferir-099','--aplicar-099-autorizado'].includes(modo),'ARGUMENTOS_RECUSADOS');
  const config = alvo(process.env), sql = lerArquivos();
  const {Client} = require('pg'); const c = new Client(config);
  await c.connect();
  try {
    const identidade = conferirIdentidade((await c.query(SQL_IDENTIDADE)).rows[0],process.env);
    if(modo==='--conferir-099') console.log(JSON.stringify({identidade,...await conferir(c,sql)}));
    else {exigirDisco(); console.log(JSON.stringify({identidade,...await aplicar(c,sql)}));}
  } finally {await c.end();}
}
if(require.main===module) main().catch(e=>{console.error('MIGRATION_099_PARADA',e.code || e.name);process.exitCode=1;});
module.exports={alvo,lerArquivos,conferir,aplicar,FILES,HASHES};
