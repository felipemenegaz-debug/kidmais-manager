/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 107 (reparo da deriva da agenda) e da 108 (salões combinados) SOMENTE no PostgreSQL do web de
// staging, num job/shell do Render do srv-daif418ae00c73e8k2gg com a MESMA árvore implantada (#267 + E4; plano "E4
// aplicadores 107 108 staging 20261029", E4-0/E4-5), com o web DRENADO (manutenção ou escala zero) e o cron suspenso
// durante as duas transações (D-E4). Alvo fixo de staging e identidade/TLS/disco de scripts/conexao-staging.cjs (mesma
// regra dos aplicadores 076–106). Núcleo em scripts/migration-107-108-comum.cjs.
//   node scripts/migration-107-108-staging.cjs                                → plano, sem conexão
//   node scripts/migration-107-108-staging.cjs --conferir-107-108             → somente leitura (mede F0/F1/F2)
//   node scripts/migration-107-108-staging.cjs --aplicar-107-108-autorizado --backup "<registro>" --drenagem "<registro>"
//                                                                             → uma vez (marcadores exclusivos)
// KIDMAIS_RETRATOS_108_TESTE (esperados injetados pela suíte PostgreSQL) é RECUSADO aqui em todos os modos.
const assert = require('node:assert/strict');
const path = require('node:path');
const {criarAplicador, ENV_RETRATOS_TESTE} = require('./migration-107-108-comum.cjs');
const {SQL_IDENTIDADE, conferirIdentidade, exigirDisco, tlsEsperado} = require('./conexao-staging.cjs');

const ALVO = Object.freeze({servico: 'srv-daif418ae00c73e8k2gg', host: 'dpg-daidko3m8hqs73ce4jt0-a', database: 'kidmais_staging_1z91', port: 5432});
const DIR = path.posix.join('/opt/render/project/src/data', 'saloes-107-108-staging');

/** Só o web de staging e o banco interno exato; TLS como a aplicação (lib/db/postgres.ts), conferido no servidor. */
function alvo(env) {
  assert.ok(env[ENV_RETRATOS_TESTE] === undefined, 'RETRATOS_DE_TESTE_RECUSADOS');
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
    application_name: 'kidmais-migration-107-108-staging', connectionTimeoutMillis: 10000};
}
/** Banco exato e TLS conforme DATABASE_SSL; sem TLS, só com o servidor em endereço privado (conexao-staging.cjs). */
function identidade(id, env) {
  try { return conferirIdentidade(id, env); } catch (e) { assert.fail('IDENTIDADE_RECUSADA ' + String(e?.message ?? '').slice(0, 40)); }
}

const aplicador = criarAplicador({nome: 'staging', ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco: () => exigirDisco(), aceitaRetratosTeste: false});
if (require.main === module) aplicador.cli();
module.exports = {ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco, ...aplicador};
