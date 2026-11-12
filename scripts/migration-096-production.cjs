/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 096 SOMENTE no PostgreSQL do web de produção, no Web Shell do srv-dak77m2d0e5s73b8rkkg, DEPOIS do
// deploy do código que a usa (ordem: código primeiro, como 088/089; sem a 096 a contratação segue sem comprovante persistido).
// Trava de alvo e identidade derivadas do aplicador da 084 de produção; núcleo em scripts/migration-096-comum.cjs.
//   node scripts/migration-096-production.cjs                                             → plano, sem conexão
//   node scripts/migration-096-production.cjs --conferir-096                              → somente leitura
//   node scripts/migration-096-production.cjs --aplicar-096-autorizado --backup "<registro>" → uma vez (marcador exclusivo)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {criarAplicador} = require('./migration-096-comum.cjs');

const ALVO = Object.freeze({servico: 'srv-dak77m2d0e5s73b8rkkg', host: 'dpg-dak750gae00c73fudmg0-a', database: 'kidmais_production', port: 5432});
const DISCO = '/opt/render/project/src/data';
const DIR = path.posix.join(DISCO, 'assinatura-comprovante-096-producao');
const SQL_IDENTIDADE = `SELECT current_database() AS db,
  (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls,
  (SELECT version FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls_versao,
  coalesce(inet_server_addr() << ANY('{10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}'::inet[]), false) AS servidor_privado`;
const VERSOES_TLS = Object.freeze(['TLSv1.2', 'TLSv1.3']);

/**
 * Só o web de produção e o banco interno exato. TLS obrigatório (DATABASE_SSL=true, mínimo TLSv1.2); a verificação do
 * certificado segue a configuração do serviço (produção usa DATABASE_SSL_REJECT_UNAUTHORIZED=false): sem ela, a
 * identidade é provada no servidor (banco, TLS ativo/versão, endereço privado). Mensagens = só o código.
 */
function alvo(env) {
  assert.ok(env.RENDER === 'true', 'FORA_DO_RENDER');
  assert.ok(env.RENDER_SERVICE_ID === ALVO.servico, 'SERVICO_RECUSADO');
  assert.ok(env.KIDMAIS_DEPLOY_ENV === 'production', 'AMBIENTE_RECUSADO');
  assert.ok(env.DATABASE_SSL === 'true', 'TLS_OBRIGATORIO');
  let u;
  try { u = new URL(env.DATABASE_URL); } catch { assert.fail('URL_RECUSADA'); }
  assert.ok(u.hostname === ALVO.host && !u.hostname.includes('.'), 'HOST_RECUSADO');
  assert.ok(decodeURIComponent(u.pathname.slice(1)) === ALVO.database, 'BANCO_RECUSADO');
  assert.ok(!u.port || Number(u.port) === ALVO.port, 'PORTA_RECUSADA');
  assert.ok(u.search === '', 'CONNECTION_QUERY_REJECTED');
  return {connectionString: env.DATABASE_URL, ssl: {rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false', minVersion: 'TLSv1.2'},
    application_name: 'kidmais-migration-096-production', connectionTimeoutMillis: 10000};
}
function identidade(id) {
  assert.ok(id?.db === ALVO.database, 'BANCO_DIVERGENTE');
  assert.ok(id.tls === true, 'SEM_TLS');
  assert.ok(VERSOES_TLS.includes(id.tls_versao), 'TLS_VERSAO_RECUSADA');
  assert.ok(id.servidor_privado === true, 'SERVIDOR_FORA_DA_REDE_PRIVADA');
  return {banco: id.db, tls: true, tlsVersao: id.tls_versao, servidorPrivado: true};
}
/** Disco persistente montado (dispositivo diferente do pai): sem ele o marcador sumiria no próximo deploy. */
function exigirDisco(disco = DISCO, stat = fs.lstatSync) {
  let d, pai;
  try { d = stat(disco); pai = stat(path.dirname(disco)); } catch { d = null; }
  assert.ok(d && d.isDirectory() && !d.isSymbolicLink() && d.dev !== pai.dev, 'DISCO_PERSISTENTE_AUSENTE');
}

const aplicador = criarAplicador({nome: 'production', ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco});
if (require.main === module) aplicador.cli();
module.exports = {ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco, ...aplicador};
