/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 090 SOMENTE no PostgreSQL do web de staging, no Web Shell do srv-daif418ae00c73e8k2gg, DEPOIS do
// deploy do código que a usa (ordem: código primeiro, como 088/089; sem a 090 o código mantém a regra anterior de 20 vagas).
// Alvo fixo de staging (serviço, ambiente, host interno, banco, porta) e identidade/TLS/disco de scripts/conexao-staging.cjs
// (mesma regra dos aplicadores 076–086). Núcleo em scripts/migration-090-comum.cjs.
//   node scripts/migration-090-staging.cjs                                             → plano, sem conexão
//   node scripts/migration-090-staging.cjs --conferir-090                              → somente leitura
//   node scripts/migration-090-staging.cjs --aplicar-090-autorizado --backup "<registro>" → uma vez (marcador exclusivo)
const assert = require('node:assert/strict');
const path = require('node:path');
const {criarAplicador} = require('./migration-090-comum.cjs');
const {SQL_IDENTIDADE, conferirIdentidade, exigirDisco, tlsEsperado} = require('./conexao-staging.cjs');

const ALVO = Object.freeze({servico: 'srv-daif418ae00c73e8k2gg', host: 'dpg-daidko3m8hqs73ce4jt0-a', database: 'kidmais_staging_1z91', port: 5432});
const DIR = path.posix.join('/opt/render/project/src/data', 'assinatura-campanha-090-staging');

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
    application_name: 'kidmais-migration-090-staging', connectionTimeoutMillis: 10000};
}
/** Banco exato e TLS conforme DATABASE_SSL; sem TLS, só com o servidor em endereço privado (conexao-staging.cjs). */
function identidade(id, env) {
  try { return conferirIdentidade(id, env); } catch (e) { assert.fail('IDENTIDADE_RECUSADA ' + String(e?.message ?? '').slice(0, 40)); }
}

const aplicador = criarAplicador({nome: 'staging', ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco: () => exigirDisco()});
if (require.main === module) aplicador.cli();
module.exports = {ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, ...aplicador};
