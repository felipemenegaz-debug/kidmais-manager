/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 104 (hash da revisão com o salão) e da 106 (salão de preferência) SOMENTE no PostgreSQL do web de staging,
// no Web Shell do srv-daif418ae00c73e8k2gg, DEPOIS do deploy do código que traz este aplicador (os SQL e as telas da S-E e da S-D já
// estão publicados: #251 e #254). Alvo fixo de staging e identidade/TLS/disco de scripts/conexao-staging.cjs (mesma
// regra dos aplicadores 076–103). Núcleo em scripts/migration-104-106-comum.cjs.
//   node scripts/migration-104-106-staging.cjs                                                → plano, sem conexão
//   node scripts/migration-104-106-staging.cjs --conferir-104-106                             → somente leitura
//   node scripts/migration-104-106-staging.cjs --aplicar-104-106-autorizado --backup "<registro>" → uma vez (marcador exclusivo)
const assert = require('node:assert/strict');
const path = require('node:path');
const {criarAplicador} = require('./migration-104-106-comum.cjs');
const {SQL_IDENTIDADE, conferirIdentidade, exigirDisco, tlsEsperado} = require('./conexao-staging.cjs');

const ALVO = Object.freeze({servico: 'srv-daif418ae00c73e8k2gg', host: 'dpg-daidko3m8hqs73ce4jt0-a', database: 'kidmais_staging_1z91', port: 5432});
const DIR = path.posix.join('/opt/render/project/src/data', 'saloes-104-106-staging');

/** Só o web de staging e o banco interno exato; TLS como a aplicação (lib/db/postgres.ts), conferido no servidor. */
function alvo(env) {
  assert.ok(env.RENDER === 'true', 'FORA_DO_RENDER');
  assert.ok(env.RENDER_SERVICE_ID === ALVO.servico, 'SERVICO_RECUSADO');
  assert.ok(env.KIDMAIS_DEPLOY_ENV === 'staging', 'AMBIENTE_RECUSADO');
  let tls;
  try { tls = tlsEsperado(env); } catch { assert.fail('TLS_CONFIGURACAO_RECUSADA'); }
  let u;
  try { u = new URL(env.DATABASE_URL); } catch { assert.fail('URL_RECUSADA'); }
  assert.ok(u.hostname === ALVO.host && !u.hostname.includes('.'), 'HOST_RECUSADO');
  assert.ok(decodeURIComponent(u.pathname.slice(1)) === ALVO.database, 'BANCO_RECUSADO');
  assert.ok(!u.port || Number(u.port) === ALVO.port, 'PORTA_RECUSADA');
  assert.ok(u.search === '', 'CONNECTION_QUERY_REJECTED');
  return {connectionString: env.DATABASE_URL, ssl: tls ? {rejectUnauthorized: true, minVersion: 'TLSv1.2'} : undefined,
    application_name: 'kidmais-migration-104-106-staging', connectionTimeoutMillis: 10000};
}
/** Banco exato e TLS conforme DATABASE_SSL; sem TLS, só com o servidor em endereço privado (conexao-staging.cjs). */
function identidade(id, env) {
  try { return conferirIdentidade(id, env); } catch (e) { assert.fail('IDENTIDADE_RECUSADA ' + String(e?.message ?? '').slice(0, 40)); }
}

const aplicador = criarAplicador({nome: 'staging', ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco: () => exigirDisco()});
if (require.main === module) aplicador.cli();
module.exports = {ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco, ...aplicador};
