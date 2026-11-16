/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 109 (renovação substituta, B-9) SOMENTE no PostgreSQL do web de produção, no Web Shell do
// srv-dak77m2d0e5s73b8rkkg, DEPOIS do deploy do código compatível com a 075 e a 109 em TODOS os consumidores (plano
// docs/PLANO_B9_PRODUCAO_PUTS_JANELA_20261029.md §3). Trava de alvo, TLS, identidade e disco no desenho dos aplicadores
// 092–094 e 100 de produção; núcleo em scripts/migration-109-comum.cjs, usado como está (o mesmo provado em staging): o
// estado vem do contrato TypeScript do cron (lib/assinatura/renovacao-schema.ts, conferido por hash antes de conectar), a
// aplicação exige nenhuma sessão `kidmais-renovacao*` ativa e production em 075 confere o conjunto 075 (retrato divergente
// recusa com os nomes; um desvio é achado a analisar, nunca valor novo a fixar). Rodar com --experimental-strip-types.
//   node --experimental-strip-types scripts/migration-109-production.cjs                                               → plano
//   node --experimental-strip-types scripts/migration-109-production.cjs --conferir-109                                → leitura
//   node --experimental-strip-types scripts/migration-109-production.cjs --aplicar-109-autorizado --backup "<registro>" → uma vez
// BLOQUEIO B-27 (07/11/2026, nota no topo do plano B-9): aplicar a 109 em production NÃO libera o `aplicar` da renovação,
// não cria nem retoma cron de cobrança/renovação e não vale como "voltar ao modo anterior". Este aplicador nunca suspende,
// cria ou reativa cron; a ativação é entrega separada, com autorização própria de Felipe.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {criarAplicador, FLAG_CONFERIR, FLAG_APLICAR} = require('./migration-109-comum.cjs');

const ALVO = Object.freeze({servico: 'srv-dak77m2d0e5s73b8rkkg', host: 'dpg-dak750gae00c73fudmg0-a', database: 'kidmais_production', port: 5432});
const DISCO = '/opt/render/project/src/data';
const DIR = path.posix.join(DISCO, 'renovacao-109-producao');
const SQL_IDENTIDADE = `SELECT current_database() AS db,
  (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls,
  (SELECT version FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls_versao,
  coalesce(inet_server_addr() << ANY('{10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}'::inet[]), false) AS servidor_privado`;
const VERSOES_TLS = Object.freeze(['TLSv1.2', 'TLSv1.3']);

/**
 * Só o web de produção e o banco interno exato. TLS obrigatório (DATABASE_SSL=true, mínimo TLSv1.2); a verificação do
 * certificado segue a configuração do serviço (produção usa DATABASE_SSL_REJECT_UNAUTHORIZED=false): sem ela, a
 * identidade é provada no servidor (banco, TLS ativo/versão, endereço privado). Mensagens = só o código. O
 * application_name não começa por `kidmais-renovacao`: o próprio aplicador não conta como sessão da renovação.
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
    application_name: 'kidmais-migration-109-production', connectionTimeoutMillis: 10000};
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
 * Ordem operacional em produção. O núcleo da 109 não recebe `ordem` (a lista dele fala do PITR "de staging" e termina em
 * "reativar o cron da renovação", que em production a nota B-27 do plano B-9 proíbe); aqui só a SAÍDA DO PLANO (modo sem
 * conexão) troca esse campo. Conferência e aplicação são as do núcleo, sem mudança.
 */
const ORDEM = Object.freeze([
  'conferir no Render o commit de TODOS os consumidores que existirem em production (web, cron da renovação, cron da reconciliação/preflight e ferramentas manuais do Shell do web): todos com o código compatível com a 075 e a 109, nenhuma execução antiga em andamento; conferir o deploy deste aplicador e os hashes implantados (o código anterior QUEBRA com a 109)',
  FLAG_CONFERIR + ': PRONTA_PARA_APLICAR (production em 075 confere o conjunto 075; RETRATO_DIVERGENTE_109 = achado a analisar, nunca valor novo a fixar)',
  'ponto de recuperação do PostgreSQL de production comprovado (PITR do Render disponível, cobrindo o horário da aplicação) e registrado (referência e horário, anterior à aplicação)',
  'autorização de Felipe para a 109 em production (com a dívida D-COBRANCA-LIVE aberta valem também os gates da nota B-27 do plano B-9 para mudança em production)',
  'janela: nenhum cron da renovação em execução (SUSPENSO, se existir) e nenhuma renovação manual/restrita/preflight em andamento (o aplicador recusa com sessão kidmais-renovacao* ativa); sem DDL concorrente; leituras e escritas de assinatura_renovacoes esperam a transação (ACCESS EXCLUSIVE, lock_timeout 5 s)',
  `${FLAG_CONFERIR} de novo, imediatamente antes`,
  FLAG_APLICAR, `${FLAG_CONFERIR}: JA_APLICADA_CAPACIDADE_PASS`,
  'B-27 (docs/PLANO_B9_PRODUCAO_PUTS_JANELA_20261029.md): em production este cutover NÃO cria nem retoma cron de cobrança ou de renovação e não libera o aplicar da renovação; a ativação é entrega separada, com autorização própria de Felipe']);

const base = criarAplicador({nome: 'production', ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco: () => exigirDisco()});
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 300);
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
