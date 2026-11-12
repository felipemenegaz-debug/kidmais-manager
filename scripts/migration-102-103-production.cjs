/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 102 (apresentação do salão) e da 103 (categoria Serviços) SOMENTE no PostgreSQL do web de produção,
// no Web Shell do srv-dak77m2d0e5s73b8rkkg, DEPOIS do deploy do código que traz este aplicador e os SQL. Trava de alvo,
// TLS, identidade e disco no desenho dos aplicadores 092–094 e 100 de produção; núcleo em
// scripts/migration-102-103-comum.cjs, usado como está (o mesmo provado em staging). A 102 recusa com a 098 presente e
// fora do PostgreSQL 18 (retrato semântico medido no 18.6); a prova do retrato roda no próprio alvo, dentro da transação
// da 102, antes do COMMIT.
//   node scripts/migration-102-103-production.cjs                                                → plano, sem conexão
//   node scripts/migration-102-103-production.cjs --conferir-102-103                             → somente leitura
//   node scripts/migration-102-103-production.cjs --aplicar-102-103-autorizado --backup "<registro>" → uma vez (marcador exclusivo)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {criarAplicador, FLAG_CONFERIR, FLAG_APLICAR} = require('./migration-102-103-comum.cjs');

const ALVO = Object.freeze({servico: 'srv-dak77m2d0e5s73b8rkkg', host: 'dpg-dak750gae00c73fudmg0-a', database: 'kidmais_production', port: 5432});
const DISCO = '/opt/render/project/src/data';
const DIR = path.posix.join(DISCO, 'saloes-102-103-producao');
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
    application_name: 'kidmais-migration-102-103-production', connectionTimeoutMillis: 10000};
}
function identidade(id) {
  assert.ok(id?.db === ALVO.database, 'BANCO_DIVERGENTE');
  assert.ok(id.tls === true, 'SEM_TLS');
  assert.ok(VERSOES_TLS.includes(id.tls_versao), 'TLS_VERSAO_RECUSADA');
  assert.ok(id.servidor_privado === true, 'SERVIDOR_FORA_DA_REDE_PRIVADA');
  return {banco: id.db, tls: true, tlsVersao: id.tls_versao, servidorPrivado: true};
}
/** Disco persistente montado (dispositivo diferente do pai, não symlink): sem ele o marcador sumiria no próximo deploy. */
function exigirDisco(disco = DISCO, stat = fs.lstatSync) {
  let d, pai;
  try { d = stat(disco); pai = stat(path.dirname(disco)); } catch { d = null; }
  assert.ok(d && d.isDirectory() && !d.isSymbolicLink() && d.dev !== pai.dev, 'DISCO_PERSISTENTE_AUSENTE');
}

/**
 * Ordem operacional em produção. O núcleo da 102/103 não recebe `ordem` (a lista dele fala do PITR "de staging"); aqui só
 * a SAÍDA DO PLANO (modo sem conexão) troca esse campo. Conferência e aplicação são as do núcleo, sem mudança.
 */
const ORDEM = Object.freeze([
  'código com este aplicador e os 7 SQL publicado em production; conferir commit e hashes implantados (bloco CONFERIR)',
  'pré-condições do núcleo: 093 aplicada (agenda_saloes, usuarios_administrativos, agenda_saloes_empresa_id_uk), 021 aplicada (adicional_categorias), SEM a 098 e PostgreSQL 18',
  FLAG_CONFERIR + ': PRONTA_PARA_APLICAR',
  'ponto de recuperação PITR do PostgreSQL de production comprovado (disponível, cobrindo o horário da aplicação) e registrado (referência e horário, anterior à aplicação); export lógico NÃO serve de recuperação desta janela',
  'autorização de Felipe para a 102/103 em production',
  'janela combinada: sem salvar agenda nem catálogo de adicionais e sem DDL concorrente (a 102 pega ACCESS EXCLUSIVE em agenda_saloes)',
  `${FLAG_CONFERIR} de novo, imediatamente antes`,
  FLAG_APLICAR, `${FLAG_CONFERIR}: JA_APLICADA_INTEGRIDADE_PASS`,
  'conferência logada: Salões, Catálogo (serviços comuns) e Agenda']);

const base = criarAplicador({nome: 'production', ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco: () => exigirDisco()});
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 160);
const plano = deps => ({...base.plano(deps), ordem: [...ORDEM]});
/** Igual ao `principal` do núcleo; só o modo plano (argv vazio, sem conexão) sai com a ordem de produção. */
async function principal(argv, env, deps = {}) {
  if (argv.length === 0) return {codigo: 0, saida: plano(deps)};
  return base.principal(argv, env, deps);
}
function cli() {
  principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
    (codigo === 0 ? console.log : console.error)(JSON.stringify(saida)); process.exitCode = codigo;
  }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
}
if (require.main === module) cli();
module.exports = {ALVO, DIR, SQL_IDENTIDADE, ORDEM, alvo, identidade, exigirDisco, ...base, plano, principal, cli};
