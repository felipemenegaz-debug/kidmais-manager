/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 105 (canal MCP por assinatura: persistência OAuth) SOMENTE no PostgreSQL do web de staging, no Web
// Shell do srv-daif418ae00c73e8k2gg, DEPOIS do deploy do código que traz este aplicador (o código do canal e a migration
// já estão publicados desde a #252). Alvo fixo de staging e identidade/TLS/disco de scripts/conexao-staging.cjs (mesma
// regra dos aplicadores 076–103). Núcleo em scripts/migration-105-comum.cjs.
//   node scripts/migration-105-staging.cjs                                               → plano, sem conexão
//   node scripts/migration-105-staging.cjs --conferir-105                                → somente leitura
//   node scripts/migration-105-staging.cjs --aplicar-105-autorizado --backup "<registro>" → uma vez (marcador exclusivo)
const assert = require('node:assert/strict');
const path = require('node:path');
const {criarAplicador} = require('./migration-105-comum.cjs');
const {SQL_IDENTIDADE, conferirIdentidade, exigirDisco, tlsEsperado} = require('./conexao-staging.cjs');

const ALVO = Object.freeze({servico: 'srv-daif418ae00c73e8k2gg', host: 'dpg-daidko3m8hqs73ce4jt0-a', database: 'kidmais_staging_1z91', port: 5432});
const DIR = path.posix.join('/opt/render/project/src/data', 'mcp-105-staging');

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
    application_name: 'kidmais-migration-105-staging', connectionTimeoutMillis: 10000};
}
/** Causas conhecidas de conferirIdentidade (conexao-staging.cjs); qualquer outra sai como OUTRA (vocabulário fechado). */
const CAUSAS_IDENTIDADE = Object.freeze(['BANCO', 'TLS', 'REDE_PRIVADA', 'SSL_CONFIGURACAO_RECUSADA', 'CERTIFICADO_SEM_VERIFICACAO_RECUSADO', 'OUTRA']);
/** Banco exato e TLS conforme DATABASE_SSL; sem TLS, só com o servidor em endereço privado (conexao-staging.cjs). */
function identidade(id, env) {
  try { return conferirIdentidade(id, env); } catch (e) {
    const causa = e?.code === 'ERR_ASSERTION' && e.generatedMessage === false ? String(e.message).split(String.fromCharCode(10), 1)[0] : '';
    assert.fail('IDENTIDADE_RECUSADA ' + (CAUSAS_IDENTIDADE.includes(causa) ? causa : 'OUTRA'));
  }
}
/** Motivos próprios deste adaptador, para o diagnóstico em vocabulário fechado do núcleo. */
const MOTIVOS = Object.freeze(['FORA_DO_RENDER', 'SERVICO_RECUSADO', 'AMBIENTE_RECUSADO', 'TLS_CONFIGURACAO_RECUSADA', 'URL_RECUSADA',
  'HOST_RECUSADO', 'BANCO_RECUSADO', 'PORTA_RECUSADA', 'CONNECTION_QUERY_REJECTED', 'DISCO_PERSISTENTE_AUSENTE',
  ...CAUSAS_IDENTIDADE.map(c => 'IDENTIDADE_RECUSADA ' + c)]);

const aplicador = criarAplicador({nome: 'staging', ALVO, DIR, SQL_IDENTIDADE, MOTIVOS, alvo, identidade, exigirDisco: () => exigirDisco()});
if (require.main === module) aplicador.cli();
module.exports = {ALVO, DIR, SQL_IDENTIDADE, MOTIVOS, CAUSAS_IDENTIDADE, alvo, identidade, exigirDisco, ...aplicador};
