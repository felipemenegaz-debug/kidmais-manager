/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 107 (reparo da deriva da agenda) e da 108 (salões combinados) SOMENTE no PostgreSQL do web de
// produção, num job/shell do Render do srv-dak77m2d0e5s73b8rkkg com a MESMA árvore implantada, com o web DRENADO
// (manutenção ou escala zero) e o cron suspenso durante as duas transações (D-E4). Trava de alvo, TLS, identidade e disco
// no desenho dos aplicadores 092–094 e 100 de produção; núcleo em scripts/migration-107-108-comum.cjs, usado como está (o
// mesmo provado em staging).
//   node scripts/migration-107-108-production.cjs                                → plano, sem conexão
//   node scripts/migration-107-108-production.cjs --conferir-107-108             → somente leitura (mede F0/F1/F2)
//   node scripts/migration-107-108-production.cjs --aplicar-107-108-autorizado --backup "<registro>" --drenagem "<registro>"
//                                                                                → uma vez (marcadores exclusivos)
// RETRATOS: o núcleo só aceita as variantes de database/checks/20261029_108_retratos_esperados.json (arquivo fixado por
// hash). Este adaptador não acrescenta variante nem mede por conta própria: passa `aceitaRetratosTeste: false` e o `env`
// do serviço, como o de staging. KIDMAIS_RETRATOS_108_TESTE (esperados injetados pela suíte PostgreSQL) é RECUSADO aqui em
// todos os modos. Se o retrato de production não for nenhuma variante aprovada, o CONFERIR mede, mostra o hash e o resumo
// por seção e recusa com RETRATO_F<n>_DIVERGENTE (código 3); o hash encontrado nunca vira referência.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {criarAplicador, ENV_RETRATOS_TESTE, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, FLAG_DRENAGEM} = require('./migration-107-108-comum.cjs');

const ALVO = Object.freeze({servico: 'srv-dak77m2d0e5s73b8rkkg', host: 'dpg-dak750gae00c73fudmg0-a', database: 'kidmais_production', port: 5432});
const DISCO = '/opt/render/project/src/data';
const DIR = path.posix.join(DISCO, 'saloes-107-108-producao');
const SQL_IDENTIDADE = `SELECT current_database() AS db,
  (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls,
  (SELECT version FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls_versao,
  coalesce(inet_server_addr() << ANY('{10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}'::inet[]), false) AS servidor_privado`;
const VERSOES_TLS = Object.freeze(['TLSv1.2', 'TLSv1.3']);

/**
 * Só o web de produção e o banco interno exato. TLS obrigatório (DATABASE_SSL=true, mínimo TLSv1.2); a verificação do
 * certificado segue a configuração do serviço (produção usa DATABASE_SSL_REJECT_UNAUTHORIZED=false): sem ela, a
 * identidade é provada no servidor (banco, TLS ativo/versão, endereço privado). Mensagens = só o código. Como no adaptador
 * de staging, o override de retratos de teste recusa antes de tudo.
 */
function alvo(env) {
  assert.ok(env[ENV_RETRATOS_TESTE] === undefined, 'RETRATOS_DE_TESTE_RECUSADOS');
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
    application_name: 'kidmais-migration-107-108-production', connectionTimeoutMillis: 10000};
}
function identidade(id) {
  assert.ok(id?.db === ALVO.database, 'BANCO_DIVERGENTE');
  assert.ok(id.tls === true, 'SEM_TLS');
  assert.ok(VERSOES_TLS.includes(id.tls_versao), 'TLS_VERSAO_RECUSADA');
  assert.ok(id.servidor_privado === true, 'SERVIDOR_FORA_DA_REDE_PRIVADA');
  return {banco: id.db, tls: true, tlsVersao: id.tls_versao, servidorPrivado: true};
}
/** Disco persistente montado (dispositivo diferente do pai, não symlink): sem ele os marcadores sumiriam no próximo deploy. */
function exigirDisco(disco = DISCO, stat = fs.lstatSync) {
  let d, pai;
  try { d = stat(disco); pai = stat(path.dirname(disco)); } catch { d = null; }
  assert.ok(d && d.isDirectory() && !d.isSymbolicLink() && d.dev !== pai.dev, 'DISCO_PERSISTENTE_AUSENTE');
}

/**
 * Ordem operacional em produção. O núcleo da 107/108 não recebe `ordem` (a lista dele fala do PITR "de staging", da #267 e
 * do CONFERIR da 098, que não existe em produção); aqui só a SAÍDA DO PLANO (modo sem conexão) troca esse campo.
 * Conferência e aplicação são as do núcleo, sem mudança.
 */
const ORDEM = Object.freeze([
  'árvore implantada em production com este aplicador, os núcleos, os checks, os retratos, as migrations e os downs (conferidos pelo bloco)',
  'pré-condições do núcleo: PostgreSQL 18; 093/094/100/102/104/106 aplicadas; SEM a 098 histórica; nenhuma aplicação parcial da 108',
  FLAG_CONFERIR + ' (mede F0; só leitura): PRONTA_PARA_APLICAR. RETRATO_F0_DIVERGENTE = o retrato de production não é nenhuma variante aprovada: PARAR (a variante só entra no arquivo de esperados depois de medida, reproduzida e revisada; o hash encontrado nunca vira referência)',
  'decisão e autorização de Felipe para a 107/108 em production',
  'ponto de recuperação PITR do PostgreSQL de production comprovado e registrado (export lógico NÃO substitui)',
  'janela drenada (D-E4): web em manutenção ou escala zero, cron suspenso, sem outros escritores, jobs nem DDL durante as DUAS transações; o aplicador roda num job/shell do Render com a MESMA árvore',
  `${FLAG_CONFERIR} de novo, imediatamente antes (atividade e sessões registradas)`, `${FLAG_APLICAR} ${FLAG_BACKUP} … ${FLAG_DRENAGEM} …`,
  FLAG_CONFERIR + ' (F2, JA_APLICADA_INTEGRIDADE_PASS)', 'CONFERIR de production da 092–094, 100, 102-103 e 104-106',
  'fim da drenagem', 'conferência logada (admin com combinados; cliente sem combinado)']);

const base = criarAplicador({nome: 'production', ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco: () => exigirDisco(), aceitaRetratosTeste: false});
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 300);
const plano = deps => ({...base.plano(deps), ordem: [...ORDEM]});
/** Igual ao `principal` do núcleo; só o modo plano (argv vazio, sem conexão) sai com a ordem de produção. */
async function principal(argv, env, deps = {}) {
  if (argv.length === 0) return {codigo: 0, saida: plano({env, raiz: deps.raiz})};
  return base.principal(argv, env, deps);
}
function cli() {
  principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
    (codigo === 0 ? console.log : console.error)(JSON.stringify(saida)); process.exitCode = codigo;
  }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
}
if (require.main === module) cli();
module.exports = {ALVO, DIR, SQL_IDENTIDADE, ORDEM, alvo, identidade, exigirDisco, ...base, plano, principal, cli};
