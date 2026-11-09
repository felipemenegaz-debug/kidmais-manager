/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 116 (franquias de IA por plano, F1) SOMENTE no PostgreSQL do web de staging, no Web Shell do
// srv-daif418ae00c73e8k2gg, DEPOIS do deploy do código que traz este aplicador e os SQL (o código da F1 já está LIVE, #319). Alvo fixo de staging e
// identidade/TLS/disco de scripts/conexao-staging.cjs (mesma regra dos aplicadores 076–112). Núcleo em
// scripts/migration-116-comum.cjs. Production fica para o plano de promoção, com adaptador e autorização próprios.
//   node scripts/migration-116-staging.cjs                                               → plano, sem conexão
//   node scripts/migration-116-staging.cjs --conferir-116                                → somente leitura
//   node scripts/migration-116-staging.cjs --aplicar-116-autorizado --backup "<registro>" → uma vez (marcador exclusivo)
const assert = require('node:assert/strict');
const path = require('node:path');
const {criarAplicador} = require('./migration-116-comum.cjs');
const {SQL_IDENTIDADE, conferirIdentidade, exigirDisco, tlsEsperado} = require('./conexao-staging.cjs');

const ALVO = Object.freeze({servico: 'srv-daif418ae00c73e8k2gg', host: 'dpg-daidko3m8hqs73ce4jt0-a', database: 'kidmais_staging_1z91', port: 5432});
const DIR = path.posix.join('/opt/render/project/src/data', 'creditos-franquias-116-staging');

/**
 * Variáveis do libpq que o `pg` lê do ambiente e que a configuração explícita abaixo não consegue anular (o `pg` só
 * consulta o ambiente quando o campo é falso ou vazio). Presentes, recusam: poderiam mudar a sessão (PGOPTIONS), o
 * protocolo (PGREPLICATION, PGBINARY, PGSSLNEGOTIATION) ou a codificação. Parecer r1 do Astra na 118, P1 (trazido para
 * a 116/117 em 08/11/2026). Nomes exatos que o `pg` lê (lib/connection-parameters.js): a codificação é
 * PGCLIENT_ENCODING ('PG' + 'client_encoding'.toUpperCase()); PGCLIENTENCODING é o nome do libpq e fica na lista por
 * precaução (parecer r2 da 118, P3). O teste confere a lista contra o fonte.
 */
const PG_HERDADAS_RECUSADAS = Object.freeze(['PGOPTIONS', 'PGREPLICATION', 'PGBINARY', 'PGSSLNEGOTIATION', 'PGCLIENT_ENCODING', 'PGCLIENTENCODING']);
/**
 * Caracteres de controle (C0 e DEL) no usuário ou na senha DEPOIS da decodificação. O pacote de inicialização separa
 * chave e valor por NUL: um usuário com `%00options%00-c ...` injetaria opções de sessão (parecer r2 da 118, P2).
 */
const CONTROLE = /[\u0000-\u001f\u007f]/;

/**
 * Só o web de staging e o banco interno exato; TLS como a aplicação (lib/db/postgres.ts), conferido no servidor.
 * A configuração do cliente é montada só com os valores validados (host, porta, banco, usuário, senha, TLS), sem
 * connectionString: PGPORT, PGHOST, PGDATABASE, PGUSER, PGPASSWORD e PGSSLMODE não têm por onde entrar.
 */
function alvo(env) {
  assert.ok(env.RENDER === 'true', 'FORA_DO_RENDER');
  assert.ok(env.RENDER_SERVICE_ID === ALVO.servico, 'SERVICO_RECUSADO');
  assert.ok(env.KIDMAIS_DEPLOY_ENV === 'staging', 'AMBIENTE_RECUSADO');
  let tls;
  try { tls = tlsEsperado(env); } catch { assert.fail('TLS_CONFIGURACAO_RECUSADA'); }
  for (const nome of PG_HERDADAS_RECUSADAS) assert.ok(env[nome] === undefined, 'AMBIENTE_PG_RECUSADO ' + nome);
  // `?` e `#` recusados mesmo vazios: URL.search e URL.hash devolvem '' para um delimitador sem conteúdo (parecer r2 da 118, P3).
  assert.ok(typeof env.DATABASE_URL === 'string' && !/[?#]/.test(env.DATABASE_URL), 'CONNECTION_QUERY_REJECTED');
  let u;
  try { u = new URL(env.DATABASE_URL); } catch { assert.fail('URL_RECUSADA'); }
  assert.ok(['postgres:', 'postgresql:'].includes(u.protocol), 'URL_RECUSADA');
  assert.ok(u.hostname === ALVO.host && !u.hostname.includes('.'), 'HOST_RECUSADO');
  assert.ok(decodeURIComponent(u.pathname.slice(1)) === ALVO.database, 'BANCO_RECUSADO');
  assert.ok(!u.port || Number(u.port) === ALVO.port, 'PORTA_RECUSADA');
  assert.ok(u.search === '' && u.hash === '', 'CONNECTION_QUERY_REJECTED');
  let user, password;
  try { user = decodeURIComponent(u.username); password = decodeURIComponent(u.password); } catch { assert.fail('URL_RECUSADA'); }
  assert.ok(user && password, 'CREDENCIAL_AUSENTE_NA_URL');
  assert.ok(!CONTROLE.test(user) && !CONTROLE.test(password), 'CREDENCIAL_COM_CONTROLE');
  const cfg = {host: ALVO.host, port: ALVO.port, database: ALVO.database, user,
    ssl: tls ? {rejectUnauthorized: true, minVersion: 'TLSv1.2'} : false,
    application_name: 'kidmais-migration-116-staging', connectionTimeoutMillis: 10000};
  // Senha fora da enumeração (não aparece em JSON.stringify nem em log do objeto).
  Object.defineProperty(cfg, 'password', {value: password, enumerable: false});
  return cfg;
}
/** Banco exato e TLS conforme DATABASE_SSL; sem TLS, só com o servidor em endereço privado (conexao-staging.cjs). */
function identidade(id, env) {
  try { return conferirIdentidade(id, env); } catch (e) { assert.fail('IDENTIDADE_RECUSADA ' + String(e?.message ?? '').slice(0, 40)); }
}

const aplicador = criarAplicador({nome: 'staging', ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco: () => exigirDisco()});
if (require.main === module) aplicador.cli();
module.exports = {ALVO, DIR, PG_HERDADAS_RECUSADAS, SQL_IDENTIDADE, alvo, identidade, exigirDisco, ...aplicador};
