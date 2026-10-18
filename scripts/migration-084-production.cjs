/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 084 (etapas duráveis da geração de IA de convites) SOMENTE no PostgreSQL do web de produção, no
// Web Shell do srv-dak77m2d0e5s73b8rkkg, ANTES do deploy do código da geração sem resultado (PR #176 em staging). O código
// atual de produção é compatível com a 084: ela só acrescenta colunas (etapas_registradas com padrão false), um estado,
// um CHECK e um índice parcial, e não altera nenhuma linha. Derivado do aplicador revisado da 079.
//   node scripts/migration-084-production.cjs                          → plano, sem conexão
//   node scripts/migration-084-production.cjs --conferir-084           → leitura: identidade, 079, precheck ou postcheck
//   node scripts/migration-084-production.cjs --aplicar-084-autorizado → precheck → migration → postcheck (uma vez)
// Executa exatamente os arquivos revisados (hash fixado, CRLF normalizado). A aplicação grava um marcador exclusivo no
// disco persistente antes de conectar: uma tentativa anterior (concluída, falha ou perdida) impede repetição automática.
// A saída tem só nomes de etapas, booleanos de schema e mensagens curtas; nunca dados de clientes nem a URL do banco.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {isDeepStrictEqual} = require('node:util');

const FLAG = '--aplicar-084-autorizado';
const FLAG_CONFERIR = '--conferir-084';
const ALVO = Object.freeze({servico: 'srv-dak77m2d0e5s73b8rkkg', host: 'dpg-dak750gae00c73fudmg0-a', database: 'kidmais_production', port: 5432});
const DISCO = '/opt/render/project/src/data';
const DIR = path.posix.join(DISCO, 'convites-geracao-pendente-producao-20261018');
const MARCADOR = 'migration-084.json';
const ETAPAS = Object.freeze([
  ['precheck 084', 'database/checks/20261018_084_precheck.sql', 'd869623076acc546b5cce443b5ad72449465f2e6660269441a1a2e05ae5d1c4c'],
  ['migration 084', 'database/migrations/20261018_084_convite_geracao_pendencias.sql', '1da540fe850119ae96a41e570f3c86eaea1249ef1fd11ece51538ed930630f2e'],
  ['postcheck 084', 'database/checks/20261018_084_postcheck.sql', 'b9ef2e59fcbce0e4218d73f6d4d9a2ae2ad833a7c8b00eadedcc90fb764dec5b'],
]);
/** Identidade da conexão vista pelo servidor: banco, TLS ativo e versão, e endereço do servidor na rede privada. */
const SQL_IDENTIDADE = `SELECT current_database() AS db,
  (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls,
  (SELECT version FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls_versao,
  coalesce(inet_server_addr() << ANY('{10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}'::inet[]), false) AS servidor_privado`;
const VERSOES_TLS = Object.freeze(['TLSv1.2', 'TLSv1.3']);
/**
 * Estado estrutural (leitura): dependências 073/079, 084 completa, qualquer vestígio parcial da 084, privilégio de DDL
 * (dono de convite_geracoes) e contagem por estado, sem ids — a 084 não pode mudar nenhuma geração existente.
 */
const SQL_SCHEMA = `SELECT to_regclass('public.convite_geracoes') IS NOT NULL AS m073,
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.convite_geracoes') AND conname='convite_geracoes_resolucao_consistente' AND convalidated)
    AND to_regclass('public.convite_geracoes_incertas') IS NOT NULL) AS m079,
  ((SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes'
      AND column_name IN ('etapas_registradas','enviado_em','recebido_em','resultado_pendente','falha_classe','falha_diagnostico','falha_detalhes')) = 7
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.convite_geracoes') AND conname='convite_geracoes_etapas_consistentes' AND convalidated)
    AND to_regclass('public.convite_geracoes_em_aberto') IS NOT NULL) AS m084,
  (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes'
      AND column_name IN ('etapas_registradas','enviado_em','recebido_em','resultado_pendente','falha_classe','falha_diagnostico','falha_detalhes'))
    OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.convite_geracoes') AND conname='convite_geracoes_etapas_consistentes')
    OR to_regclass('public.convite_geracoes_em_aberto') IS NOT NULL) AS vestigio084,
  coalesce((SELECT pg_has_role(current_user, c.relowner, 'USAGE') FROM pg_class c WHERE c.oid = to_regclass('public.convite_geracoes')), false)
    AND has_schema_privilege(current_user, 'public', 'CREATE') AS privilegio084,
  (SELECT coalesce(jsonb_object_agg(estado, n), '{}'::jsonb) FROM (SELECT estado, count(*) AS n FROM convite_geracoes GROUP BY estado) e) AS estados`;

/**
 * Trava de alvo: só o web de produção e o banco interno exato. TLS obrigatório (DATABASE_SSL=true, mínimo TLSv1.2);
 * a verificação do certificado segue a configuração do próprio serviço (lib/db/postgres.ts e P0 de 11/10), porque o
 * produção usa DATABASE_SSL_REJECT_UNAUTHORIZED=false. Sem verificação, a identidade é provada no servidor: banco, TLS
 * ativo/versão e endereço do servidor em faixa privada (conferirIdentidade). Mensagens = só o código, sem diff de valores.
 */
function alvo(env) {
  assert.ok(env.RENDER === 'true', 'FORA_DO_RENDER');
  assert.ok(env.RENDER_SERVICE_ID === ALVO.servico, 'SERVICO_RECUSADO');
  assert.ok(env.KIDMAIS_DEPLOY_ENV === 'production', 'AMBIENTE_RECUSADO');
  assert.ok(env.DATABASE_SSL === 'true', 'TLS_OBRIGATORIO');
  let u;
  try { u = new URL(env.DATABASE_URL); } catch { assert.fail('URL_RECUSADA'); }
  // Host exato do banco interno (sem domínio): a conexão nunca sai da rede privada do Render.
  assert.ok(u.hostname === ALVO.host && !u.hostname.includes('.'), 'HOST_RECUSADO');
  assert.ok(decodeURIComponent(u.pathname.slice(1)) === ALVO.database, 'BANCO_RECUSADO');
  assert.ok(!u.port || Number(u.port) === ALVO.port, 'PORTA_RECUSADA');
  assert.ok(u.search === '', 'CONNECTION_QUERY_REJECTED');
  const verificarCertificado = env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false';
  return {connectionString: env.DATABASE_URL, ssl: {rejectUnauthorized: verificarCertificado, minVersion: 'TLSv1.2'},
    application_name: 'kidmais-migration-084-production', connectionTimeoutMillis: 10000};
}

/** Identidade provada pelo servidor; vale com ou sem verificação do certificado. */
function conferirIdentidade(id) {
  assert.ok(id?.db === ALVO.database, 'BANCO_DIVERGENTE');
  assert.ok(id.tls === true, 'SEM_TLS');
  assert.ok(VERSOES_TLS.includes(id.tls_versao), 'TLS_VERSAO_RECUSADA');
  assert.ok(id.servidor_privado === true, 'SERVIDOR_FORA_DA_REDE_PRIVADA');
  return {banco: id.db, tls: id.tls, tlsVersao: id.tls_versao, servidorPrivado: true};
}

function lerRevisado(raiz, arquivo, hash) {
  const sql = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(sql, 'utf8').digest('hex'), hash, 'ARQUIVO_DIVERGENTE ' + arquivo);
  return sql;
}
function flags(argv) { return argv.filter(x => x.startsWith('--')); }
function autorizado(argv) { return argv.length === 1 && flags(argv)[0] === FLAG; }
function conferencia(argv) { return argv.length === 1 && flags(argv)[0] === FLAG_CONFERIR; }

/**
 * Estado legível e dependências presentes (073 e 079); vestígio sem a 084 completa = aplicação parcial → parar. Sem ser
 * dono de convite_geracoes (ALTER, CHECK e índice) a migration falharia: recusar antes de qualquer escrita. O CREATE no
 * schema public é exigido como na 079 (mais restritivo que o necessário, sem efeito colateral). Na conferência não há marcador; na aplicação o marcador de
 * disco já existe e fica FALHA — por isso a conferência é obrigatória antes.
 */
function planoEtapas(schema) {
  for (const k of ['m073', 'm079', 'm084', 'vestigio084', 'privilegio084']) assert.equal(typeof schema?.[k], 'boolean', 'SCHEMA_ILEGIVEL');
  assert.ok(schema.m073 && schema.m079, 'DEPENDENCIA_AUSENTE_073_079');
  if (schema.m084) return ['postcheck 084'];
  assert.ok(!schema.vestigio084, 'APLICACAO_PARCIAL_084');
  assert.ok(schema.privilegio084, 'SEM_PRIVILEGIO_DDL_084');
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
  const [nome, arquivo, hash] = r.schema.m084 ? ETAPAS[2] : ETAPAS[0];
  await somenteLeitura(db, lerRevisado(raiz, arquivo, hash));
  r[nome.split(' ')[0]] = 'PASS';
  r.resultado = r.schema.m084 ? 'JA_APLICADA_POSTCHECK_PASS' : 'PRONTA_PARA_APLICAR';
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
    if (nome === 'migration 084') {
      try { await db.query(sqls.get(nome)); } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
    } else await somenteLeitura(db, sqls.get(nome));
    Object.assign(r.etapas.at(-1), {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.schemaDepois = (await somenteLeitura(db, SQL_SCHEMA)).rows[0];
  assert.ok(r.schemaDepois.m084, 'SCHEMA_DEPOIS');
  // A 084 não tem DML. A contagem por estado é informativa: o app em produção pode concluir uma geração entre as duas
  // leituras, e isso não pode virar FALHA de uma DDL já confirmada (o postcheck é o critério).
  r.estadosIguais = isDeepStrictEqual(r.schemaDepois.estados, r.schemaAntes.estados);
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
  // Último progresso gravado: numa falha, o marcador mantém as etapas já concluídas (ex.: migration ok antes do erro).
  let ultimo = {};
  const db = new Client(opts); db.on?.('error', () => undefined);
  try {
    await db.connect();
    const certificadoVerificado = opts.ssl.rejectUnauthorized;
    const r = await aplicarNoCliente(db, {raiz, registrar: x => { ultimo = JSON.parse(JSON.stringify({...x, certificadoVerificado})); salvar({...ultimo, situacao: 'EM_ANDAMENTO'}); }});
    salvar({...r, certificadoVerificado, situacao: 'CONCLUIDA'});
    return {resultado: r.resultado, marcador, conexao: {...r.conexao, certificadoVerificado}, schemaAntes: r.schemaAntes, schemaDepois: r.schemaDepois,
      estadosIguais: r.estadosIguais, etapas: r.etapas.map(e => e.nome)};
  } catch (e) {
    const falha = {mensagem: String(e?.message ?? e).slice(0, 160)};
    salvar({...ultimo, situacao: 'FALHA', falha});
    return {resultado: 'FALHA', marcador, falha};
  } finally { await db.end().catch(() => {}); }
}

async function conferir({env, raiz = path.resolve(__dirname, '..'), Client = require('pg').Client}) {
  const opts = alvo(env);
  const db = new Client(opts); db.on?.('error', () => undefined);
  try {
    await db.connect();
    const r = await conferirNoCliente(db, {raiz});
    return {...r, conexao: {...r.conexao, certificadoVerificado: opts.ssl.rejectUnauthorized}};
  }
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
  else { console.error('AGUARDANDO_AUTORIZACAO_084'); process.exitCode = 1; }
}
module.exports = {ALVO, DIR, ETAPAS, FLAG, FLAG_CONFERIR, MARCADOR, SQL_IDENTIDADE, SQL_SCHEMA, alvo, autorizado, conferencia, conferirIdentidade,
  lerRevisado, planoEtapas, conferirNoCliente, aplicarNoCliente, exigirDisco, executar, conferir};
