/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual da 118 (cota de leitura de documentos da importação de contratos, L2) SOMENTE no PostgreSQL do web de
// PRODUÇÃO, no Web Shell do srv-dak77m2d0e5s73b8rkkg, DEPOIS do deploy de uma árvore que traga este aplicador e os 3 SQL.
// Núcleo comum com staging (scripts/migration-118-comum.cjs, sem mudança). Trava de conexão igual à de staging (r3 do
// Astra: configuração explícita sem connectionString, variáveis do libpq que não dá para anular recusadas, credencial
// sem caractere de controle); identidade no desenho dos aplicadores de produção (105): TLS ativo com versão conhecida,
// servidor em rede privada, sessão membro do papel efetivo, nenhum superusuário e papel efetivo DONO de empresas e de
// ia_documentos (as tabelas da 118 nascem com o mesmo dono que o código usa).
//   node scripts/migration-118-production.cjs                                                        → plano, sem conexão
//   node scripts/migration-118-production.cjs --conferir-118                                         → somente leitura
//   node scripts/migration-118-production.cjs --aplicar-118-autorizado --backup "PITR <AAAA-MM-DDTHH:MMZ> <ref>" → uma vez
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const nodeTls = require('node:tls');
const {criarAplicador, modo, FLAG_CONFERIR, FLAG_APLICAR} = require('./migration-118-comum.cjs');

const ALVO = Object.freeze({servico: 'srv-dak77m2d0e5s73b8rkkg', host: 'dpg-dak750gae00c73fudmg0-a', database: 'kidmais_production', port: 5432});
const DISCO = '/opt/render/project/src/data';
const DIR = path.posix.join(DISCO, 'importacao-cotas-118-producao');

/** Mesma lista do adaptador de staging (parecer r1 do Astra, P1; r2, P3); o teste a confere contra o fonte do `pg`. */
const PG_HERDADAS_RECUSADAS = Object.freeze(['PGOPTIONS', 'PGREPLICATION', 'PGBINARY', 'PGSSLNEGOTIATION', 'PGCLIENT_ENCODING', 'PGCLIENTENCODING']);
/**
 * Autenticação do SERVIDOR (parecer r2 da produção, P2; rodada 4, D-118-TLS). O certificado interno do Render é
 * autoassinado (verify-ca/verify-full não suportados na rede interna), então, com DATABASE_SSL_REJECT_UNAUTHORIZED=false
 * (como a aplicação), o PADRÃO é o canal ligado:
 *  - canal ligado (padrão, nenhuma variável): o login TEM de ser SCRAM-SHA-256-PLUS (tls-server-end-point) terminado com a
 *    assinatura do servidor conferida. Só quem guarda o verificador SCRAM da credencial do web assina; o hash do certificado
 *    que o cliente viu entra na prova, então um intermediário com outro certificado é recusado pelo servidor real. Qualquer
 *    outro caminho (senha em claro, MD5, SCRAM sem PLUS, "autenticado" sem SASL, SASL fora de ordem) é recusado ANTES de o
 *    cliente reagir à mensagem; nenhuma consulta sai em caso algum (clienteCanalLigado). A garantia sobre a PROVA é por fase:
 *    só ANTES de o desafio ser repassado nenhuma senha ou prova sai (falha CANAL_ANTES_DA_PROVA).
 *    RESIDUAL (pareceres r4 e r5, P2; RFC 5802 §9): um impostor que ofereça o PLUS e mande um desafio válido RECEBE a prova
 *    do cliente (ClientProof), termine depois como terminar (assinatura falsa, Ok prematuro, repetição, fechamento, timeout);
 *    com ela pode testar palpites da senha OFFLINE. Não recebe consulta nem dado. Toda falha dessa fase sai como
 *    CANAL_PROVA_EXPOSTA = parar e girar a credencial do web. Prova zero para impostor só com CA/pin (KIDMAIS_118_TLS_CA + PIN).
 *  - CA confiável: KIDMAIS_118_TLS_CA (PEM em base64) → o certificado é verificado no HANDSHAKE (rejectUnauthorized), antes de
 *    qualquer mensagem de inicialização; KIDMAIS_118_TLS_PIN (sha256 hex do certificado do servidor, DER) fixa a folha.
 *  - exceção explícita de Felipe: KIDMAIS_118_TLS_EXCECAO exatamente "D-118-TLS <AAAA-MM-DD> Felipe aceita servidor sem
 *    certificado verificado", registrada na saída e no marcador.
 */
const EXCECAO_TLS = /^D-118-TLS (20\d{2})-(\d{2})-(\d{2}) Felipe aceita servidor sem certificado verificado$/;
const PIN = /^[0-9a-f]{64}$/;
const CANAL_LIGADO = 'canal-ligado SCRAM-SHA-256-PLUS';
/** Únicas mensagens de autenticação aceitas no canal ligado, e só nesta ordem: SASL → (Continue) → Final → Ok. */
const AUTENTICACAO_CANAL = Object.freeze(['authenticationSASL', 'authenticationSASLContinue', 'authenticationSASLFinal', 'authenticationOk']);
/**
 * Prefixo de toda falha de login no canal ligado. ANTES_DA_PROVA: saíram só o SSLRequest, a inicialização e, no máximo, a
 * resposta inicial do SASL (nonce, sem nada derivado da senha) → parar. PROVA_EXPOSTA: o desafio foi repassado ao pg e a
 * prova pode ter saído → parar e girar a credencial do web antes de qualquer nova tentativa (D-118-TLS-R).
 */
const FASE_ANTES_DA_PROVA = 'CANAL_ANTES_DA_PROVA';
const FASE_PROVA_EXPOSTA = 'CANAL_PROVA_EXPOSTA';
/**
 * Cliente do `pg` que exige o canal ligado quando a configuração pede (enableChannelBinding, só no modo canal-ligado); nos
 * outros modos é o cliente original. Intercepta `connection.emit` ANTES dos ouvintes do cliente: uma mensagem recusada nunca
 * chega ao cliente (que mandaria a senha em claro, o MD5 ou a prova SCRAM sem PLUS) e vira erro com o código da recusa.
 */
function clienteCanalLigado(Base) {
  return class ClienteCanalLigado extends Base {
    // A exigência vem da CONFIGURAÇÃO recebida (alvo), não do cliente: um cliente que ignore enableChannelBinding é recusado.
    #exigeCanal;
    constructor(cfg, ...r) { super(cfg, ...r); this.#exigeCanal = cfg?.enableChannelBinding === true; }
    async connect(...a) {
      if (!this.#exigeCanal) return super.connect(...a);
      const con = this.connection;
      assert.ok(this.enableChannelBinding === true && con && typeof con.emit === 'function' && a.length === 0, 'CANAL_LIGADO_INDISPONIVEL');
      const estado = {plus: false, desafio: false, final: false, recusa: null};
      const emitir = con.emit.bind(con);
      const recusar = codigo => {
        estado.recusa ??= codigo;
        try { con.stream?.destroy?.(); } catch { /* já fechado */ }
        return emitir('error', new Error(estado.recusa));
      };
      con.emit = (ev, ...args) => {
        if (estado.recusa) return ['error', 'end', 'close'].includes(ev) ? emitir(ev, ...args) : false;
        if (typeof ev !== 'string' || !ev.startsWith('authentication')) return emitir(ev, ...args);
        if (!AUTENTICACAO_CANAL.includes(ev)) return recusar('CANAL_SEM_SCRAM');
        if (ev === 'authenticationSASL') {
          if (estado.plus) return recusar('CANAL_FORA_DE_ORDEM');
          if (!(con.stream instanceof nodeTls.TLSSocket) || con.stream.encrypted !== true) return recusar('CANAL_SEM_TLS');
          const mec = args[0]?.mechanisms;
          if (!Array.isArray(mec) || !mec.includes('SCRAM-SHA-256-PLUS')) return recusar('CANAL_SEM_PLUS');
          const r = emitir(ev, ...args);
          if (this.saslSession?.mechanism !== 'SCRAM-SHA-256-PLUS') return recusar('CANAL_SEM_PLUS');
          estado.plus = true;
          return r;
        }
        if (!estado.plus || estado.final) return recusar(ev === 'authenticationOk' ? 'CANAL_NAO_AUTENTICADO' : 'CANAL_FORA_DE_ORDEM');
        if (ev === 'authenticationOk') return recusar('CANAL_NAO_AUTENTICADO');
        // Um único desafio, marcado ANTES de repassar (parecer r4, P3): dois desafios no mesmo pacote iniciariam dois
        // tratadores assíncronos do pg e duas provas. O Final só depois do desafio.
        if (ev === 'authenticationSASLContinue') {
          if (estado.desafio) return recusar('CANAL_FORA_DE_ORDEM');
          estado.desafio = true;
          return emitir(ev, ...args);
        }
        if (!estado.desafio) return recusar('CANAL_FORA_DE_ORDEM');
        if (ev === 'authenticationSASLFinal') {
          const r = emitir(ev, ...args);
          // O cliente só zera a sessão depois de conferir a assinatura do servidor (finalizeSession).
          if (this.saslSession === null) { estado.final = true; con.emit = (e2, ...a2) => conferirOk(e2, a2); }
          return r;
        }
        return emitir(ev, ...args);
      };
      // Depois do Final conferido: aceita UM authenticationOk e nada mais de autenticação.
      let ok = false;
      const conferirOk = (ev, args) => {
        if (estado.recusa) return ['error', 'end', 'close'].includes(ev) ? emitir(ev, ...args) : false;
        if (typeof ev === 'string' && ev.startsWith('authentication')) {
          if (ev !== 'authenticationOk' || ok) return recusar('CANAL_FORA_DE_ORDEM');
          ok = true;
        }
        return emitir(ev, ...args);
      };
      // Fase de QUALQUER falha do login (parecer r5, P2): depois de repassado o desafio, o pg pode já ter mandado a prova
      // (ClientProof) a um servidor ainda não autenticado, seja qual for o fim (recusa, Ok prematuro, repetição, fechamento,
      // timeout, assinatura falsa). O operador decide pela fase, não pelo código da recusa.
      const fase = e => new Error((estado.desafio ? FASE_PROVA_EXPOSTA : FASE_ANTES_DA_PROVA) + ' ' + (estado.recusa ?? String(e?.message ?? e)));
      try { await super.connect(); } catch (e) { throw fase(e); }
      if (!(estado.plus && estado.final && ok)) { await this.end().catch(() => {}); throw fase(new Error('CANAL_NAO_AUTENTICADO')); }
    }
  };
}
const clientes = new WeakMap();
function clienteSeguro(Base = require('pg').Client) {
  if (!clientes.has(Base)) clientes.set(Base, clienteCanalLigado(Base));
  return clientes.get(Base);
}
function modoTls(env) {
  const ca = env.KIDMAIS_118_TLS_CA, pin = env.KIDMAIS_118_TLS_PIN, excecao = env.KIDMAIS_118_TLS_EXCECAO;
  assert.ok(pin === undefined || PIN.test(pin), 'TLS_PIN_INVALIDO');
  assert.ok(pin === undefined || ca !== undefined, 'TLS_PIN_SEM_CA');
  if (ca !== undefined) {
    assert.ok(excecao === undefined, 'TLS_CA_E_EXCECAO_JUNTAS');
    let pem;
    try { pem = Buffer.from(ca, 'base64').toString('utf8'); } catch { pem = ''; }
    let valido = false;
    try { valido = /^-----BEGIN CERTIFICATE-----\r?\n/.test(pem) && new crypto.X509Certificate(pem).raw.length > 0; } catch { valido = false; }
    assert.ok(valido, 'TLS_CA_INVALIDA');
    return {modo: pin ? 'ca+pin' : 'ca', ca: pem, pin};
  }
  if (env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false') { assert.ok(excecao === undefined, 'TLS_EXCECAO_DESNECESSARIA'); return {modo: 'ca-do-sistema'}; }
  if (excecao === undefined) return {modo: CANAL_LIGADO};
  const m = EXCECAO_TLS.exec(String(excecao));
  assert.ok(m, 'TLS_EXCECAO_INVALIDA');
  const [a, me, d] = m.slice(1, 4).map(Number), x = new Date(Date.UTC(a, me - 1, d));
  assert.ok(x.getUTCFullYear() === a && x.getUTCMonth() === me - 1 && x.getUTCDate() === d, 'TLS_EXCECAO_INVALIDA');
  return {modo: 'excecao', excecao};
}
/** Folha fixada: comparada no handshake (checkServerIdentity só roda com a cadeia já verificada pela CA). */
function conferirPin(pin) {
  return (_host, cert) => {
    const raw = cert && cert.raw;
    if (!Buffer.isBuffer(raw)) return new Error('TLS_PIN_ILEGIVEL');
    return crypto.createHash('sha256').update(raw).digest('hex') === pin ? undefined : new Error('TLS_PIN_DIVERGENTE');
  };
}
/** C0 e DEL no usuário ou na senha depois da decodificação (parecer r2, P2): o pacote de inicialização separa por NUL. */
const CONTROLE = /[\u0000-\u001f\u007f]/;

const dono = t => `coalesce((SELECT c.relowner = r.oid FROM pg_class c, pg_roles r WHERE c.oid = to_regclass('public.${t}') AND r.rolname = current_user), false)`;
/** Tabela da 118: NULL se ausente; senão, se o papel efetivo (o mesmo do web) é o dono (parecer r1, P2: a 118 já presente). */
const dono118 = t => `(SELECT c.relowner = r.oid FROM pg_class c, pg_roles r WHERE c.oid = to_regclass('public.${t}') AND r.rolname = current_user)`;
/** Função da 118 usada pelo código: NULL se ausente; senão, EXECUTE para o papel efetivo. */
const executa118 = f => `CASE WHEN to_regprocedure('public.${f}') IS NULL THEN NULL ELSE has_function_privilege(current_user, to_regprocedure('public.${f}'), 'EXECUTE') END`;
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
  ${dono('ia_documentos')} AS dono_documentos,
  md5(session_user::text) AS sessao_md5,
  ${dono118('ia_importacao_cotas')} AS dono_cotas,
  ${dono118('ia_importacao_usos')} AS dono_usos,
  ${executa118('kidmais_118_periodo_mensal(timestamptz)')} AS executa_periodo,
  ${executa118('kidmais_118_janela_migracao(timestamptz,timestamptz)')} AS executa_janela`;
const VERSOES_TLS = Object.freeze(['TLSv1.2', 'TLSv1.3']);

/**
 * Só o web de produção e o banco interno exato. TLS obrigatório (DATABASE_SSL=true, mínimo TLSv1.2); autenticação do
 * servidor (modoTls): canal ligado SCRAM-SHA-256-PLUS por padrão, CA confiável no handshake (pin opcional) ou exceção
 * explícita registrada. A configuração do cliente leva só os valores validados (host, porta,
 * banco, usuário, senha, TLS), sem connectionString. Mensagens = só o código, nunca a URL ou a senha.
 */
function alvo(env) {
  assert.ok(env.RENDER === 'true', 'FORA_DO_RENDER');
  assert.ok(env.RENDER_SERVICE_ID === ALVO.servico, 'SERVICO_RECUSADO');
  assert.ok(env.KIDMAIS_DEPLOY_ENV === 'production', 'AMBIENTE_RECUSADO');
  assert.ok(env.DATABASE_SSL === 'true', 'TLS_OBRIGATORIO');
  assert.ok([undefined, 'true', 'false'].includes(env.DATABASE_SSL_REJECT_UNAUTHORIZED), 'TLS_CONFIGURACAO_RECUSADA');
  for (const nome of PG_HERDADAS_RECUSADAS) assert.ok(env[nome] === undefined, 'AMBIENTE_PG_RECUSADO ' + nome);
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
  const tls = modoTls(env);
  const ssl = tls.modo === 'excecao' || tls.modo === CANAL_LIGADO ? {rejectUnauthorized: false, minVersion: 'TLSv1.2'}
    : tls.modo === 'ca-do-sistema' ? {rejectUnauthorized: true, minVersion: 'TLSv1.2'}
    : {rejectUnauthorized: true, minVersion: 'TLSv1.2', ca: tls.ca, ...(tls.pin ? {checkServerIdentity: conferirPin(tls.pin)} : {})};
  const cfg = {host: ALVO.host, port: ALVO.port, database: ALVO.database, user, ssl,
    application_name: 'kidmais-migration-118-production', connectionTimeoutMillis: 10000,
    ...(tls.modo === CANAL_LIGADO ? {enableChannelBinding: true} : {})};
  Object.defineProperty(cfg, 'password', {value: password, enumerable: false});
  return cfg;
}
/**
 * Banco, TLS e rede como os demais aplicadores de produção; PAPEL: a sessão é membro do papel efetivo (o `SET role` do
 * Render, ou o próprio papel), nenhum dos dois é superusuário e o papel efetivo é o DONO de empresas e de ia_documentos.
 */
function identidade(id, env) {
  const credencial = alvo(env).user;
  try {
    assert.ok(id?.db === ALVO.database, 'BANCO_DIVERGENTE');
    assert.ok(id.tls === true, 'SEM_TLS');
    assert.ok(VERSOES_TLS.includes(id.tls_versao), 'TLS_VERSAO_RECUSADA');
    assert.ok(id.servidor_privado === true, 'SERVIDOR_FORA_DA_REDE_PRIVADA');
    assert.ok(typeof id.papel_trocado === 'boolean', 'PAPEL_ILEGIVEL');
    assert.ok(id.sessao_membro === true, 'SESSAO_FORA_DO_PAPEL');
    assert.ok(id.papel_superusuario === false && id.sessao_superusuario === false, 'SUPERUSUARIO_RECUSADO');
    assert.ok(id.dono_empresas === true && id.dono_documentos === true, 'PAPEL_NAO_E_DONO_DA_APLICACAO');
    // A sessão é a credencial do próprio web (DATABASE_URL), não qualquer par sessão/papel que cumpra os critérios.
    assert.ok(id.sessao_md5 === crypto.createHash('md5').update(credencial, 'utf8').digest('hex'), 'SESSAO_NAO_E_A_CREDENCIAL_DO_WEB');
    // 118 já presente (parcial é recusada pelo núcleo): o web, com o mesmo papel, precisa escrever e executar o que usa.
    for (const k of ['dono_cotas', 'dono_usos', 'executa_periodo', 'executa_janela']) assert.ok(id[k] === null || id[k] === true, 'WEB_SEM_ESCRITA_NA_118 ' + k);
  } catch (e) { assert.fail('IDENTIDADE_RECUSADA ' + String(e?.message ?? '').slice(0, 40)); }
  const t = modoTls(env);
  return {banco: id.db, tls: true, tlsVersao: id.tls_versao, tlsVerificacao: t.modo === 'excecao' ? t.excecao : t.modo,
    servidorPrivado: true, papelTrocado: id.papel_trocado, papelDono: true,
    sessaoCredencialDoWeb: true, web118: id.dono_cotas === null ? 'ausente' : 'dono'};
}
/** Disco persistente montado (dispositivo diferente do pai, não symlink): sem ele o marcador sumiria no próximo deploy. */
function exigirDisco(disco = DISCO, stat = fs.lstatSync) {
  let d, pai;
  try { d = stat(disco); pai = stat(path.dirname(disco)); } catch { d = null; }
  assert.ok(d && d.isDirectory() && !d.isSymbolicLink() && d.dev !== pai.dev, 'DISCO_PERSISTENTE_AUSENTE');
}

/**
 * Ordem de produção (complementa a ordem do núcleo; o plano de promoção decide a janela, D-118-1). A 118 só cria objetos e
 * o código antigo de produção não os lê: é compatível com o código antes e depois da L2. Com a L2 no ar e sem a 118, a
 * importação responde 503 COTA_INDISPONIVEL (a dispensa só vale para o web de staging, lista fechada no código).
 */
const ORDEM = Object.freeze([
  'árvore implantada no web de produção com este aplicador, o núcleo e os 3 SQL; conferir commit e sha256 implantados (bloco CONFERIR confere)',
  'servidor autenticado (D-118-TLS): por padrão o login TEM de ser SCRAM-SHA-256-PLUS com a assinatura do servidor conferida (canal ligado; sem PLUS o aplicador recusa antes de mandar senha ou prova); falha CANAL_ANTES_DA_PROVA = parar; CANAL_PROVA_EXPOSTA, login travado ou falha de conexão sem um desses prefixos (exceto CANAL_LIGADO_INDISPONIVEL, antes de conectar) = parar e girar a credencial do web antes de nova tentativa; alternativas: KIDMAIS_118_TLS_CA (+ KIDMAIS_118_TLS_PIN) ou KIDMAIS_118_TLS_EXCECAO registrada por Felipe',
  FLAG_CONFERIR + ': PRONTA_PARA_APLICAR (JA_APLICADA_POSTCHECK_PASS = não aplicar; pular para a conferência funcional)',
  'autorização de Felipe para a 118 em produção',
  'PITR (gate operacional): Felipe confere no painel do Render que o ponto de restauração cobre o instante da aplicação e anota "PITR <AAAA-MM-DDTHH:MMZ> <referencia>" conferido contra `date -u` do Shell',
  'janela curta, sem importação em andamento: o aplicador espera no máximo 5 s pela trava (lock_timeout); depois de obtida, escritas em empresas e uploads (ia_documentos) esperam o FIM da transação da 118, inclusive as verificações antes do COMMIT (statement_timeout 60 s por comando)',
  `${FLAG_CONFERIR} de novo, imediatamente antes`,
  FLAG_APLICAR, `${FLAG_CONFERIR}: JA_APLICADA_POSTCHECK_PASS`,
  'conferência funcional só com CONTRACT_IMPORT ligado e autorização própria (empresa de teste de produção, PDF sintético; conta 1 leitura)']);

/** Mesma janela do bloco de Shell (parecer r1, P2): o PITR anotado é uma data real, no máximo 2 h antes do relógio e nunca no futuro. */
const JANELA_PITR_MS = 2 * 60 * 60 * 1000;
const BACKUP = /^PITR (20\d{2})-(\d{2})-(\d{2})T(\d{2}):(\d{2})Z ([A-Za-z0-9:._/-][A-Za-z0-9:._/ -]{0,89})$/;
function exigirBackup(backup, agora = Date.now()) {
  const m = BACKUP.exec(String(backup ?? ''));
  assert.ok(m, 'BACKUP_NAO_INFORMADO');
  const [a, me, d, h, mi] = m.slice(1, 6).map(Number);
  const t = Date.UTC(a, me - 1, d, h, mi);
  const x = new Date(t);
  assert.ok(x.getUTCFullYear() === a && x.getUTCMonth() === me - 1 && x.getUTCDate() === d && x.getUTCHours() === h && x.getUTCMinutes() === mi, 'BACKUP_HORARIO_ILEGIVEL');
  assert.ok(Number.isFinite(agora) && agora - t >= 0 && agora - t <= JANELA_PITR_MS, 'BACKUP_FORA_DA_JANELA');
  return t;
}

const base = criarAplicador({nome: 'production', ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco: () => exigirDisco()});
/** O executar e a CLI de produção recusam o backup ANTES do alvo, do disco e da conexão; o resto é o núcleo. */
/**
 * PLANO de produção (parecer r1, P2): o núcleo exige a L2 publicada; em produção a 118 é compatível com o código antigo, e a
 * árvore implantada só precisa trazer este aplicador, os 2 núcleos e os 3 SQL (artefato só de ferramentas, ou a candidata).
 */
const PRE_REQUISITO_ARVORE = 'árvore implantada no web de produção com este aplicador, migration-118-comum.cjs, migration-092-094-comum.cjs e os 3 SQL (artefato só de ferramentas, SEM a L2, ou a candidata com a L2): a 118 é compatível com o código antigo e com o novo; janela conforme a D-ESC-8';
function plano(o = {}) {
  const p = base.plano(o);
  return {...p, preRequisitos: [...p.preRequisitos.filter(r => !/^código da L2/.test(r)), PRE_REQUISITO_ARVORE], ordemProducao: ORDEM};
}
/** O cliente do núcleo passa sempre pelo canal ligado (só age quando a configuração pede, modo padrão). */
const comCliente = o => ({...o, Client: clienteSeguro(o.Client)});
async function conferir(o = {}) { return base.conferir(comCliente(o)); }
async function executar(o = {}) { exigirBackup(o.backup, o.agora ?? Date.now()); const {agora: _a, ...resto} = o; void _a; return base.executar(comCliente(resto)); }
async function principal(argv, env, deps = {}) {
  const m = modo(argv);
  if (m.modo === 'plano') return {codigo: 0, saida: plano(deps)};
  if (m.modo === 'aplicar') exigirBackup(m.backup, deps.agora ?? Date.now());
  const {agora: _a, ...resto} = deps; void _a;
  return base.principal(argv, env, comCliente(resto));
}
function cli() {
  principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
    (codigo === 0 ? console.log : console.error)(JSON.stringify(saida)); process.exitCode = codigo;
  }).catch(e => { console.error('RECUSADO ' + String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 300)); process.exitCode = 1; });
}
const aplicador = {...base, plano, conferir, executar, principal, cli};
if (require.main === module) aplicador.cli();
module.exports = {ALVO, DIR, DISCO, PG_HERDADAS_RECUSADAS, SQL_IDENTIDADE, ORDEM, PRE_REQUISITO_ARVORE, JANELA_PITR_MS, BACKUP, EXCECAO_TLS,
  CANAL_LIGADO, AUTENTICACAO_CANAL, FASE_ANTES_DA_PROVA, FASE_PROVA_EXPOSTA, alvo, identidade, modoTls, conferirPin, clienteSeguro, exigirDisco, exigirBackup, ...aplicador};
