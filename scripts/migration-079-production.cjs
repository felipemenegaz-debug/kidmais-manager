/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 079 (recuperação manual de convites) SOMENTE no PostgreSQL do web de produção, executado por Felipe
// no Web Shell do srv-dak77m2d0e5s73b8rkkg, ANTES do deploy da Convites V1 (o código atual de produção é compatível com a
// 079: ela só acrescenta colunas com default, estados e um índice).
//   node scripts/migration-079-production.cjs                          → plano, sem conexão
//   node scripts/migration-079-production.cjs --conferir-079           → leitura: identidade, 073/074, precheck ou postcheck
//   node scripts/migration-079-production.cjs --aplicar-079-autorizado → precheck → migration → postcheck (uma vez)
// Executa exatamente os arquivos revisados (hash fixado, CRLF normalizado). A aplicação grava um marcador exclusivo no
// disco persistente antes de conectar: uma tentativa anterior (concluída, falha ou perdida) impede repetição automática.
// A saída tem só nomes de etapas, booleanos de schema e mensagens curtas; nunca dados de clientes nem a URL do banco.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const FLAG = '--aplicar-079-autorizado';
const FLAG_CONFERIR = '--conferir-079';
const ALVO = Object.freeze({servico: 'srv-dak77m2d0e5s73b8rkkg', host: 'dpg-dak750gae00c73fudmg0-a', database: 'kidmais_production', port: 5432});
const DISCO = '/opt/render/project/src/data';
const DIR = path.posix.join(DISCO, 'convites-v1-producao-20261017');
const MARCADOR = 'migration-079.json';
const ETAPAS = Object.freeze([
  ['precheck 079', 'database/checks/20261011_079_precheck.sql', '50e82cbffd07085f0ef180a5850ed9379b3a89cd4ce1bad020af33645c2ad08c'],
  ['migration 079', 'database/migrations/20261011_079_convite_recuperacao_manual.sql', '23e300ea3e2013b072e6d45348698f3bae3c3e392f6c4e34bdd67edd5f82b209'],
  ['postcheck 079', 'database/checks/20261011_079_postcheck.sql', 'c0eb23d374f856fb6c0c0b590170a4b60f298758565a4884d94399d1ec5abf3e'],
]);
const SQL_IDENTIDADE = 'SELECT current_database() AS db, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls';
/** Estado estrutural (leitura): dependências 073/074, 079 completa e qualquer vestígio parcial da 079. */
const SQL_SCHEMA = `SELECT to_regclass('public.convite_carteiras') IS NOT NULL AS m073,
  to_regclass('public.convite_familias') IS NOT NULL AS m074,
  ((SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes'
      AND column_name IN ('resolucao_resultado','resolucao_por','resolucao_em','resolucao_evidencia','reserva_microusd')) = 5
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.convite_geracoes') AND conname='convite_geracoes_resolucao_consistente' AND convalidated)
    AND to_regclass('public.convite_geracoes_incertas') IS NOT NULL) AS m079,
  (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes'
      AND column_name IN ('resolucao_resultado','resolucao_por','resolucao_em','resolucao_evidencia','reserva_microusd'))
    OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.convite_geracoes') AND conname='convite_geracoes_resolucao_consistente')
    OR to_regclass('public.convite_geracoes_incertas') IS NOT NULL) AS vestigio079`;

/** Trava de alvo: só o web de produção, o banco interno exato e TLS verificado como o serviço (lib/db/postgres.ts). */
function alvo(env) {
  assert.equal(env.RENDER, 'true', 'FORA_DO_RENDER');
  assert.equal(env.RENDER_SERVICE_ID, ALVO.servico, 'SERVICO_RECUSADO');
  assert.equal(env.KIDMAIS_DEPLOY_ENV, 'production', 'AMBIENTE_RECUSADO');
  assert.equal(env.DATABASE_SSL, 'true', 'TLS_OBRIGATORIO');
  assert.notEqual(env.DATABASE_SSL_REJECT_UNAUTHORIZED, 'false', 'CERTIFICADO_SEM_VERIFICACAO_RECUSADO');
  let u;
  try { u = new URL(env.DATABASE_URL); } catch { assert.fail('URL_RECUSADA'); }
  assert.equal(u.hostname, ALVO.host, 'HOST_RECUSADO');
  assert.equal(decodeURIComponent(u.pathname.slice(1)), ALVO.database, 'BANCO_RECUSADO');
  assert.ok(!u.port || Number(u.port) === ALVO.port, 'PORTA_RECUSADA');
  assert.equal(u.search, '', 'CONNECTION_QUERY_REJECTED');
  return {connectionString: env.DATABASE_URL, ssl: {rejectUnauthorized: true}, application_name: 'kidmais-migration-079-production'};
}

function conferirIdentidade(id) {
  assert.equal(id?.db, ALVO.database, 'BANCO_DIVERGENTE');
  assert.equal(id.tls, true, 'SEM_TLS');
  return {banco: id.db, tls: id.tls};
}

function lerRevisado(raiz, arquivo, hash) {
  const sql = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(sql, 'utf8').digest('hex'), hash, 'ARQUIVO_DIVERGENTE ' + arquivo);
  return sql;
}
function flags(argv) { return argv.filter(x => x.startsWith('--')); }
function autorizado(argv) { return argv.length === 1 && flags(argv)[0] === FLAG; }
function conferencia(argv) { return argv.length === 1 && flags(argv)[0] === FLAG_CONFERIR; }

/** Estado legível e dependências presentes; vestígio sem a 079 completa = aplicação parcial → parar. */
function planoEtapas(schema) {
  for (const k of ['m073', 'm074', 'm079', 'vestigio079']) assert.equal(typeof schema?.[k], 'boolean', 'SCHEMA_ILEGIVEL');
  assert.ok(schema.m073 && schema.m074, 'DEPENDENCIA_AUSENTE_073_074');
  if (schema.m079) return ['postcheck 079'];
  assert.ok(!schema.vestigio079, 'APLICACAO_PARCIAL_079');
  return ETAPAS.map(([nome]) => nome);
}

async function somenteLeitura(db, sql) {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    await db.query("SET LOCAL statement_timeout = '30s'");
    const r = await db.query(sql);
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}

/** Conferência (nenhuma escrita no banco nem no disco): identidade, schema e o check aplicável em READ ONLY. */
async function conferirNoCliente(db, {raiz = path.resolve(__dirname, '..'), identidade = conferirIdentidade} = {}) {
  const r = {modo: 'conferencia'};
  r.conexao = identidade((await somenteLeitura(db, SQL_IDENTIDADE)).rows[0]);
  r.schema = (await somenteLeitura(db, SQL_SCHEMA)).rows[0];
  r.plano = planoEtapas(r.schema);
  const [nome, arquivo, hash] = r.schema.m079 ? ETAPAS[2] : ETAPAS[0];
  await somenteLeitura(db, lerRevisado(raiz, arquivo, hash));
  r[nome.split(' ')[0]] = 'PASS';
  r.resultado = r.schema.m079 ? 'JA_APLICADA_POSTCHECK_PASS' : 'PRONTA_PARA_APLICAR';
  return r;
}

/** Aplicação: precheck (READ ONLY) → migration (transação própria do arquivo) → postcheck (READ ONLY) → schema depois. */
async function aplicarNoCliente(db, {raiz = path.resolve(__dirname, '..'), registrar = () => {}, identidade = conferirIdentidade} = {}) {
  const sqls = new Map(ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]));
  const r = {etapas: []};
  r.conexao = identidade((await somenteLeitura(db, SQL_IDENTIDADE)).rows[0]); registrar(r);
  r.schemaAntes = (await somenteLeitura(db, SQL_SCHEMA)).rows[0];
  r.plano = planoEtapas(r.schemaAntes); registrar(r);
  for (const nome of r.plano) {
    r.etapas.push({nome, inicio: new Date().toISOString()}); registrar(r);
    if (nome === 'migration 079') {
      try { await db.query(sqls.get(nome)); } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
    } else await somenteLeitura(db, sqls.get(nome));
    Object.assign(r.etapas.at(-1), {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.schemaDepois = (await somenteLeitura(db, SQL_SCHEMA)).rows[0];
  assert.ok(r.schemaDepois.m079, 'SCHEMA_DEPOIS');
  r.resultado = r.plano.length === 1 ? 'JA_APLICADA_POSTCHECK_PASS' : 'APLICADA_POSTCHECK_PASS';
  registrar(r);
  return r;
}

/** Disco persistente montado (dispositivo diferente do pai): sem ele o marcador sumiria no próximo deploy. */
function exigirDisco(disco = DISCO, stat = fs.lstatSync) {
  let d, pai;
  try { d = stat(disco); pai = stat(path.dirname(disco)); } catch { d = null; }
  assert.ok(d && d.isDirectory() && !d.isSymbolicLink() && d.dev !== pai.dev, 'DISCO_PERSISTENTE_AUSENTE');
}

async function executar({env, dir = DIR, raiz = path.resolve(__dirname, '..'), Client = require('pg').Client, disco = () => exigirDisco()}) {
  const opts = alvo(env); disco();
  for (const [, arquivo, hash] of ETAPAS) lerRevisado(raiz, arquivo, hash);
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const marcador = path.join(dir, MARCADOR);
  const registro = {inicio: new Date().toISOString(), situacao: 'INICIADA'};
  try { fs.writeFileSync(marcador, JSON.stringify(registro, null, 2), {flag: 'wx', mode: 0o600}); }
  catch (e) { if (e?.code === 'EEXIST') assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador); throw e; }
  const salvar = r => fs.writeFileSync(marcador, JSON.stringify({...registro, ...r}, null, 2), {mode: 0o600});
  const db = new Client(opts); db.on?.('error', () => undefined);
  try {
    await db.connect();
    const r = await aplicarNoCliente(db, {raiz, registrar: x => salvar({...x, situacao: 'EM_ANDAMENTO'})});
    salvar({...r, situacao: 'CONCLUIDA'});
    return {resultado: r.resultado, marcador, conexao: r.conexao, schemaAntes: r.schemaAntes, schemaDepois: r.schemaDepois, etapas: r.etapas.map(e => e.nome)};
  } catch (e) {
    const falha = {mensagem: String(e?.message ?? e).slice(0, 160)};
    salvar({situacao: 'FALHA', falha});
    return {resultado: 'FALHA', marcador, falha};
  } finally { await db.end().catch(() => {}); }
}

async function conferir({env, raiz = path.resolve(__dirname, '..'), Client = require('pg').Client}) {
  const db = new Client(alvo(env)); db.on?.('error', () => undefined);
  try { await db.connect(); return await conferirNoCliente(db, {raiz}); }
  catch (e) { return {modo: 'conferencia', resultado: 'FALHA', mensagem: String(e?.message ?? e).slice(0, 160)}; }
  finally { await db.end().catch(() => {}); }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const sair = (ok, s) => { (ok ? console.log : console.error)(JSON.stringify(s)); if (!ok) process.exitCode = 2; };
  const recusar = e => { console.error(String(e?.message ?? 'RECUSADO').slice(0, 120)); process.exitCode = 1; };
  if (argv.length === 0) console.log(JSON.stringify({modo: 'PLANO_SEM_CONEXAO', alvo: ALVO, etapas: ETAPAS.map(([nome, arquivo, sha256]) => ({nome, arquivo, sha256}))}, null, 2));
  else if (conferencia(argv)) conferir({env: process.env}).then(s => sair(s.resultado !== 'FALHA', s)).catch(recusar);
  else if (autorizado(argv)) executar({env: process.env}).then(s => sair(s.resultado !== 'FALHA', s)).catch(recusar);
  else { console.error('AGUARDANDO_AUTORIZACAO_079'); process.exitCode = 1; }
}
module.exports = {ALVO, DIR, ETAPAS, FLAG, FLAG_CONFERIR, MARCADOR, SQL_SCHEMA, alvo, autorizado, conferencia, conferirIdentidade,
  lerRevisado, planoEtapas, conferirNoCliente, aplicarNoCliente, exigirDisco, executar, conferir};
