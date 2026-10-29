/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 105 (canal MCP por assinatura: persistência OAuth) SOMENTE no PostgreSQL do web de produção, no
// Web Shell do srv-dak77m2d0e5s73b8rkkg. Plano MCP produção pré-requisitos (rev. 3), item P1. A 105 vem na JANELA
// PRÓPRIA do MCP, depois da promoção geral que leva o código do canal DORMENTE (sem a 105 e sem MCP_ENABLED), já com este
// aplicador e os SQL na árvore implantada. Trava de alvo e TLS no desenho dos aplicadores 089/092–094/099/100 de
// produção (B-1..B-3); identidade com o PAPEL conferido (o Render entra com `SET role`: session_user = credencial,
// current_user = dono; lição de 14/10/2026). Núcleo em scripts/migration-105-production-nucleo.cjs.
//   node scripts/migration-105-production.cjs                                                        → plano, sem conexão
//   node scripts/migration-105-production.cjs --conferir-105                                         → somente leitura
//   node scripts/migration-105-production.cjs --aplicar-105-autorizado --backup "PITR <AAAA-MM-DDTHH:MMZ> <ref>" → uma vez
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {criarAplicador, FLAG_CONFERIR, FLAG_APLICAR} = require('./migration-105-production-nucleo.cjs');

const ALVO = Object.freeze({servico: 'srv-dak77m2d0e5s73b8rkkg', host: 'dpg-dak750gae00c73fudmg0-a', database: 'kidmais_production', port: 5432});
const DISCO = '/opt/render/project/src/data';
const DIR = path.posix.join(DISCO, 'mcp-105-producao');
const dono = t => `coalesce((SELECT c.relowner = r.oid FROM pg_class c, pg_roles r WHERE c.oid = to_regclass('public.${t}') AND r.rolname = current_user), false)`;
/** Identidade e papel (só booleanos e a versão do TLS saem daqui; nenhum nome de papel). */
const SQL_IDENTIDADE = `SELECT current_database() AS db,
  (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls,
  (SELECT version FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls_versao,
  coalesce(inet_server_addr() << ANY('{10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}'::inet[]), false) AS servidor_privado,
  (session_user <> current_user) AS papel_trocado,
  pg_has_role(session_user, current_user, 'MEMBER') AS sessao_membro,
  coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), true) AS papel_superusuario,
  coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), true) AS sessao_superusuario,
  ${dono('empresas')} AS dono_empresas,
  ${dono('usuarios_administrativos')} AS dono_usuarios`;
const VERSOES_TLS = Object.freeze(['TLSv1.2', 'TLSv1.3']);

/**
 * Só o web de produção e o banco interno exato. TLS obrigatório (DATABASE_SSL=true, mínimo TLSv1.2); a verificação do
 * certificado segue a configuração do serviço (produção usa DATABASE_SSL_REJECT_UNAUTHORIZED=false): sem ela, a
 * identidade é provada no servidor (banco, TLS ativo/versão, endereço privado, papel). Mensagens = só o código.
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
    application_name: 'kidmais-migration-105-production', connectionTimeoutMillis: 10000};
}
/**
 * Banco, TLS e rede como os demais aplicadores de produção; PAPEL: a sessão é membro do papel efetivo (o `SET role` do
 * Render, ou o próprio papel), nenhum dos dois é superusuário e o papel efetivo é o DONO das tabelas da aplicação
 * (empresas e usuarios_administrativos): as tabelas da 105 nascem com o mesmo dono que o código usa.
 */
function identidade(id) {
  assert.ok(id?.db === ALVO.database, 'BANCO_DIVERGENTE');
  assert.ok(id.tls === true, 'SEM_TLS');
  assert.ok(VERSOES_TLS.includes(id.tls_versao), 'TLS_VERSAO_RECUSADA');
  assert.ok(id.servidor_privado === true, 'SERVIDOR_FORA_DA_REDE_PRIVADA');
  assert.equal(typeof id.papel_trocado, 'boolean', 'PAPEL_ILEGIVEL');
  assert.ok(id.sessao_membro === true, 'SESSAO_FORA_DO_PAPEL');
  assert.ok(id.papel_superusuario === false && id.sessao_superusuario === false, 'SUPERUSUARIO_RECUSADO');
  assert.ok(id.dono_empresas === true && id.dono_usuarios === true, 'PAPEL_NAO_E_DONO_DA_APLICACAO');
  return {banco: id.db, tls: true, tlsVersao: id.tls_versao, servidorPrivado: true, papelTrocado: id.papel_trocado, papelDono: true};
}
/** Disco persistente montado (dispositivo diferente do pai, não symlink): sem ele o marcador sumiria no próximo deploy. */
function exigirDisco(disco = DISCO, stat = fs.lstatSync) {
  let d, pai;
  try { d = stat(disco); pai = stat(path.dirname(disco)); } catch { d = null; }
  assert.ok(d && d.isDirectory() && !d.isSymbolicLink() && d.dev !== pai.dev, 'DISCO_PERSISTENTE_AUSENTE');
}

/** Ordem da janela do MCP (plano P1/P3, passo 5): PITR → CONFERIR → APLICAR → deploy desligado → CONFERIR; ligar é outro passo. */
const ORDEM = Object.freeze([
  'promoção geral concluída com o código do MCP DORMENTE (sem a 105, MCP_ENABLED desligado), já com este aplicador e os 5 SQL; conferir commit e hashes implantados',
  FLAG_CONFERIR + ': PRONTA_PARA_APLICAR',
  'autorização de Felipe para a 105 em produção',
  'PITR (gate operacional): Felipe confere no painel do Render que o ponto de restauração cobre o instante da aplicação e anota "PITR <AAAA-MM-DDTHH:MMZ> <referencia>" (vale 120 min)',
  'janela combinada: sem DDL concorrente; escritas em usuarios_administrativos e empresas podem esperar até 5 s (FKs)',
  `${FLAG_CONFERIR} de novo, imediatamente antes`,
  FLAG_APLICAR, `${FLAG_CONFERIR}: JA_APLICADA_INTEGRIDADE_PASS`,
  'deploy com o canal desligado → CONFERIR depois; variáveis (P3), monitoramento (P4) e ligar só para o piloto são passos SEPARADOS, com autorização própria']);

const aplicador = criarAplicador({nome: 'production', ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco: () => exigirDisco(), ordem: ORDEM});
if (require.main === module) aplicador.cli();
module.exports = {ALVO, DIR, SQL_IDENTIDADE, ORDEM, alvo, identidade, exigirDisco, ...aplicador};
