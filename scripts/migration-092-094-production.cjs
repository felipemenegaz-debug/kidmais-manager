/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 092–094 SOMENTE no PostgreSQL do web de produção, no Web Shell do srv-dak77m2d0e5s73b8rkkg, em DUAS
// execuções separadas (plano de promoção de 25/10/2026, B-1):
//   - escopo 092-093, com o código ANTIGO ainda publicado (a 092 tem de vir antes do código que grava PONTO; a 093 é
//     compatível com os dois códigos). Recusa se a 094 já estiver presente e nunca aplica a 094;
//   - escopo 094, só DEPOIS do deploy do código novo (o código antigo de produção não reconhece os corpos de função da 094
//     no manifesto Festa e o health cairia). Exige 092 e 093 completas.
// Não há modo `todas` em produção. Trava de alvo e identidade derivadas do aplicador da 089 de produção; núcleo em
// scripts/migration-092-094-comum.cjs (integridade da 094 reconhece o corpo da 100 — #236).
//   node scripts/migration-092-094-production.cjs                                                  → plano, sem conexão
//   node scripts/migration-092-094-production.cjs --conferir-092-094                               → diagnóstico global (só leitura)
//   node scripts/migration-092-094-production.cjs --conferir-092-093                               → conferência do E3 (só leitura)
//   node scripts/migration-092-094-production.cjs --conferir-094                                   → conferência do E6 (só leitura)
//   node scripts/migration-092-094-production.cjs --aplicar-092-093-autorizado --backup "<registro>" → E3, uma vez
//   node scripts/migration-092-094-production.cjs --aplicar-094-autorizado --backup "<registro>"     → E6, uma vez
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {criarAplicador, FLAG_CONFERIR_092_093, FLAG_CONFERIR_094, FLAG_APLICAR_092_093, FLAG_APLICAR_094} = require('./migration-092-094-comum.cjs');

const ALVO = Object.freeze({servico: 'srv-dak77m2d0e5s73b8rkkg', host: 'dpg-dak750gae00c73fudmg0-a', database: 'kidmais_production', port: 5432});
const DISCO = '/opt/render/project/src/data';
const DIR = path.posix.join(DISCO, 'agenda-precos-092-094-producao');
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
    application_name: 'kidmais-migration-092-094-production', connectionTimeoutMillis: 10000};
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

/**
 * Ordem operacional (runbook do plano de promoção, E3 e E6); cada aplicação tem autorização própria. Cada etapa usa a
 * conferência do PRÓPRIO escopo (o E3 não depende de requisitos exclusivos da 094); --conferir-092-094 é só diagnóstico.
 */
const ORDEM = Object.freeze([
  'E3 (código ANTIGO publicado): este aplicador e os SQL chegam ao Shell pelo mecanismo revisado de entrega antes do código (D-OP-2)',
  FLAG_CONFERIR_092_093, 'backup restaurável de production registrado (dump conferido + PITR; export funcional não substitui)', 'autorização de Felipe para o escopo 092-093',
  'janela combinada: manutenção, consumidores pausados, sem escritas de agenda/preços nem DDL concorrente', `${FLAG_CONFERIR_092_093} de novo, imediatamente antes`,
  FLAG_APLICAR_092_093, `${FLAG_CONFERIR_092_093}: 092 e 093 completas, 094 AUSENTE`,
  'deploy do código novo (E5) e checkpoint de barreira (E5b)',
  `E6 (código NOVO publicado): ${FLAG_CONFERIR_094}`, 'autorização de Felipe para o escopo 094', `${FLAG_CONFERIR_094} de novo, imediatamente antes`,
  FLAG_APLICAR_094, `${FLAG_CONFERIR_094}: 092, 093 e 094 completas`]);

const aplicador = criarAplicador({nome: 'production', ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco, escopos: ['092-093', '094'], ordem: ORDEM});
if (require.main === module) aplicador.cli();
module.exports = {ALVO, DIR, SQL_IDENTIDADE, ORDEM, alvo, identidade, exigirDisco, ...aplicador};
