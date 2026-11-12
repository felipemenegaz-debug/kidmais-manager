/* eslint-disable @typescript-eslint/no-require-imports */
// Alvo, identidade e disco de PRODUÇÃO para os adaptadores da promoção de 12/11/2026 (112, 114, 116, 117 e o aplicador
// genérico de 120, 121, 110, 111 e 115). As constantes e as regras são CÓPIA das do molde de produção
// (scripts/migration-100-production.cjs; o teste confere uma a uma contra ele): só o web de produção
// (srv-dak77m2d0e5s73b8rkkg), o banco interno exato, TLS obrigatório, identidade provada no servidor (banco, TLS ativo com
// versão conhecida, endereço privado) e disco persistente montado. Nada aqui conecta: são funções puras sobre o env e
// sobre a linha de identidade que o aplicador lê.
// Duas formas de configuração do cliente:
//   - alvoMolde: igual à do molde (connectionString) — para os adaptadores cujo par de staging também usa connectionString
//     (112 e 114);
//   - alvoRigido: a rigidez dos adaptadores de staging da 116, 117 e 118 (parecer do Astra na 118): variáveis PG* herdadas
//     que a configuração explícita não anula recusam, `?` e `#` recusam mesmo vazios, credencial sem caractere de controle,
//     configuração só com os valores validados (sem connectionString) e senha fora da enumeração.
// Mensagens = só o código; nunca a URL, o host ou a senha.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ALVO = Object.freeze({servico: 'srv-dak77m2d0e5s73b8rkkg', host: 'dpg-dak750gae00c73fudmg0-a', database: 'kidmais_production', port: 5432});
const DISCO = '/opt/render/project/src/data';
const SQL_IDENTIDADE = `SELECT current_database() AS db,
  (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls,
  (SELECT version FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls_versao,
  coalesce(inet_server_addr() << ANY('{10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}'::inet[]), false) AS servidor_privado`;
const VERSOES_TLS = Object.freeze(['TLSv1.2', 'TLSv1.3']);
/** Mesma lista dos adaptadores de staging da 116/117/118; o teste a confere contra o fonte do `pg`. */
const PG_HERDADAS_RECUSADAS = Object.freeze(['PGOPTIONS', 'PGREPLICATION', 'PGBINARY', 'PGSSLNEGOTIATION', 'PGCLIENT_ENCODING', 'PGCLIENTENCODING']);
/** C0 e DEL no usuário ou na senha depois da decodificação: o pacote de inicialização separa chave e valor por NUL. */
const CONTROLE = /[\u0000-\u001f\u007f]/;

function exigirAmbiente(env) {
  assert.ok(env.RENDER === 'true', 'FORA_DO_RENDER');
  assert.ok(env.RENDER_SERVICE_ID === ALVO.servico, 'SERVICO_RECUSADO');
  assert.ok(env.KIDMAIS_DEPLOY_ENV === 'production', 'AMBIENTE_RECUSADO');
  assert.ok(env.DATABASE_SSL === 'true', 'TLS_OBRIGATORIO');
}
function exigirUrl(u) {
  assert.ok(u.hostname === ALVO.host && !u.hostname.includes('.'), 'HOST_RECUSADO');
  assert.ok(decodeURIComponent(u.pathname.slice(1)) === ALVO.database, 'BANCO_RECUSADO');
  assert.ok(!u.port || Number(u.port) === ALVO.port, 'PORTA_RECUSADA');
}
/** TLS como o molde: mínimo TLSv1.2; a verificação do certificado segue a configuração do serviço. */
const ssl = env => ({rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false', minVersion: 'TLSv1.2'});

/** Configuração do cliente como a do molde de produção (migration-100-production.cjs), com o application_name dado. */
function alvoMolde(env, applicationName) {
  exigirAmbiente(env);
  let u;
  try { u = new URL(env.DATABASE_URL); } catch { assert.fail('URL_RECUSADA'); }
  exigirUrl(u);
  assert.ok(u.search === '', 'CONNECTION_QUERY_REJECTED');
  return {connectionString: env.DATABASE_URL, ssl: ssl(env), application_name: applicationName, connectionTimeoutMillis: 10000};
}
/** Mesmo alvo, com a rigidez dos adaptadores de staging da 116/117/118 (ver o cabeçalho). */
function alvoRigido(env, applicationName) {
  exigirAmbiente(env);
  assert.ok([undefined, 'true', 'false'].includes(env.DATABASE_SSL_REJECT_UNAUTHORIZED), 'TLS_CONFIGURACAO_RECUSADA');
  for (const nome of PG_HERDADAS_RECUSADAS) assert.ok(env[nome] === undefined, 'AMBIENTE_PG_RECUSADO ' + nome);
  assert.ok(typeof env.DATABASE_URL === 'string' && !/[?#]/.test(env.DATABASE_URL), 'CONNECTION_QUERY_REJECTED');
  let u;
  try { u = new URL(env.DATABASE_URL); } catch { assert.fail('URL_RECUSADA'); }
  assert.ok(['postgres:', 'postgresql:'].includes(u.protocol), 'URL_RECUSADA');
  exigirUrl(u);
  assert.ok(u.search === '' && u.hash === '', 'CONNECTION_QUERY_REJECTED');
  let user, password;
  try { user = decodeURIComponent(u.username); password = decodeURIComponent(u.password); } catch { assert.fail('URL_RECUSADA'); }
  assert.ok(user && password, 'CREDENCIAL_AUSENTE_NA_URL');
  assert.ok(!CONTROLE.test(user) && !CONTROLE.test(password), 'CREDENCIAL_COM_CONTROLE');
  const cfg = {host: ALVO.host, port: ALVO.port, database: ALVO.database, user, ssl: ssl(env),
    application_name: applicationName, connectionTimeoutMillis: 10000};
  // Senha fora da enumeração (não aparece em JSON.stringify nem em log do objeto).
  Object.defineProperty(cfg, 'password', {value: password, enumerable: false});
  return cfg;
}
/** Identidade provada pelo servidor, como no molde: banco de produção, TLS ativo 1.2/1.3 e servidor em rede privada. */
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
/** Pasta de marcador própria de produção, dentro do disco persistente. */
const pastaRegistro = nome => { assert.match(nome, /^[a-z0-9-]+-producao$/, 'REGISTRO_INVALIDO'); return path.posix.join(DISCO, nome); };

/**
 * Passos de produção comuns a todo adaptador desta promoção (roteiro, não autorização): `id` é o número da migration,
 * `conferir`/`aplicar` as flags do núcleo e `janela` o que a transação trava.
 */
function ordemProducao({id, conferir, aplicar, janela}) {
  return Object.freeze([
    'árvore implantada no web de produção com este aplicador, o núcleo e os SQL; conferir commit e sha256 implantados (o bloco CONFERIR confere)',
    `passos anteriores da cadeia concluídos com código 0 (scripts/promocao-production-ordem.cjs); qualquer código diferente de 0 para a cadeia`,
    `${conferir}: PRONTA_PARA_APLICAR (JA_APLICADA_POSTCHECK_PASS = não aplicar)`,
    'backup restaurável de production registrado (dump conferido + PITR; export funcional não substitui)',
    `autorização de Felipe para a ${id} em produção`,
    `janela curta, sem DDL concorrente: ${janela}`,
    `${conferir} de novo, imediatamente antes`, aplicar, `${conferir}: JA_APLICADA_POSTCHECK_PASS`]);
}
/**
 * Embrulha o aplicador do núcleo sem alterá-lo: o PLANO de produção ganha `ordemProducao` (e, se dado, um ajuste dos textos
 * do núcleo que citam staging); conferir, executar e os códigos de saída são os do núcleo.
 */
function adaptar(base, {ordem, ajustarPlano = p => p}) {
  const plano = (o = {}) => ({...ajustarPlano(base.plano(o)), ordemProducao: ordem});
  async function principal(argv, env, deps = {}) {
    if (argv.length === 0) return {codigo: 0, saida: plano(deps)};
    return base.principal(argv, env, deps);
  }
  function cli() {
    principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
      (codigo === 0 ? console.log : console.error)(JSON.stringify(saida)); process.exitCode = codigo;
    }).catch(e => { console.error('RECUSADO ' + String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 300)); process.exitCode = 1; });
  }
  return {...base, plano, principal, cli};
}

module.exports = {ALVO, DISCO, SQL_IDENTIDADE, VERSOES_TLS, PG_HERDADAS_RECUSADAS, CONTROLE, alvoMolde, alvoRigido, identidade, exigirDisco, pastaRegistro,
  ordemProducao, adaptar};
