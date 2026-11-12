/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 118 (cota de leitura de documentos da importação, staging) com cliente simulado que só CONFIRMA no COMMIT e
// descarta no ROLLBACK: hashes dos SQL, molduras, estado pelos 7 objetos do catálogo (ausente/presente/parcial), versão do
// servidor, privilégios um a um, trava de alvo, conferência só leitura, migration sem o COMMIT final com preservação (2
// tabelas existentes), índices e postcheck na transação, situação do COMMIT (NAO_COMMITADA / CONFIRMADO /
// DESFEITA_PELO_SERVIDOR / INDETERMINADO, inclusive 40003 e EPIPE), marcador anti-repetição, retomada pelo marcador
// renomeado e dispensa só informada. Sem rede nem banco (a prova real é lib/importacao-contrato/aplicador-118.postgres.test.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const comum = require('./migration-118-comum.cjs');
const {lerRevisado} = require('./migration-092-094-comum.cjs');
const stg = require('./migration-118-staging.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_STG = 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91';
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false', DATABASE_URL: URL_STG});
const ID_STG = {db: 'kidmais_staging_1z91', tls: false, servidor_privado: true};
const BACKUP = 'PITR 2026-11-08T22:00Z staging';
const ler = nome => { const [, a, h] = comum.ETAPAS.find(e => e[0] === nome); return lerRevisado(raiz, a, h); };
const M118 = ler('migration 118'), POS118 = ler('postcheck 118'), PRE118 = ler('precheck 118');
const DOWN118 = fs.readFileSync(path.join(raiz, 'database/rollback/20261104_118_importacao_cotas_down.sql'), 'utf8').replace(/\r\n/g, '\n');
const C118 = comum.semCommitFinal(M118, 'm118');
const CORPO_PRE = comum.corpoSomenteLeitura(PRE118, 'pre'), CORPO_POS = comum.corpoSomenteLeitura(POS118, 'pos');
const erroPg = (code, msg = 'erro simulado') => Object.assign(new Error(msg), {code, severity: 'ERROR'});
const erroNode = (code, syscall = 'write') => Object.assign(new Error(code + ' simulado'), {code, errno: -32, syscall});
const CHEIO = Object.freeze(Object.fromEntries(Object.entries(comum.OBJETOS).map(([k, v]) => [k, v.length])));
const VAZIO = Object.freeze(Object.fromEntries(Object.keys(comum.OBJETOS).map(k => [k, 0])));
const privilegios = (extra = {}) => ({versao_pg: 180006, empresas: true, documentos: true, referencias_empresas: true, referencias_documentos: true,
  ler_empresas: true, ler_documentos: true, ler_cotas: true, ler_usos: true, usar_public: true, pode_criar: true, plpgsql: true, linguagem_sql: true,
  papel_trocado: true, indices_invalidos: [], ...extra});
const estado = (objetos = VAZIO, extra = {}) => ({...privilegios(extra), ...objetos});
const PLANO_TUDO = ['precheck 118', 'migration 118', 'postcheck 118'];
const NOVAS = Object.freeze({cotas: 0, reservadas: 0, consumidas: 0, liberadas: 0});
const ZERO = Object.freeze(Object.fromEntries(comum.PRESERVADAS.map(t => [t, 0])));

/**
 * Cliente simulado transacional: o corpo da migration (sem COMMIT) deixa os 7 objetos PENDENTES; 'COMMIT' confirma e
 * 'ROLLBACK' descarta. SQL_ESTADO devolve o estado CONFIRMADO. Opções: aplicada (inicial), objetos (contagem inicial
 * explícita), extra (privilégios), falharEm (trecho que lança `erro`), falharCommit ({n, erro} ou {n, rollback: true}),
 * preservacao (o que a prova devolve), naoCompleta (COMMIT não deixa os objetos), objetosDepoisDe ({n, objetos}).
 */
function clienteFalso({aplicada = false, objetos, extra, identidade = ID_STG, falharEm, erro, falharCommit, preservacao, naoCompleta, objetosDepoisDe, semUsagePublic, invalidosNaTransacao, novas} = {}) {
  const log = []; let ro = false, pendente = null, commits = 0, leiturasEstado = 0;
  const atual = {objetos: objetos ?? (aplicada ? CHEIO : VAZIO), aplicada};
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') ro = true;
      log.push({sql, ro, emTransacao: pendente !== null});
      if (falharEm && sql.includes(falharEm)) { if (pendente) pendente.abortada = true; throw erro ?? erroPg('55P03', 'falha simulada em ' + falharEm); }
      if (sql === 'ROLLBACK') { ro = false; pendente = null; return {rows: [], command: 'ROLLBACK'}; }
      if (sql === 'COMMIT') {
        commits++;
        if (falharCommit && falharCommit.n === commits) {
          if (falharCommit.rollback) { pendente = null; return {rows: [], command: 'ROLLBACK'}; }
          throw falharCommit.erro;
        }
        if (pendente) { pendente.aplicar(); pendente = null; }
        return {rows: [], command: 'COMMIT'};
      }
      if (sql.startsWith('SELECT current_database()')) return {rows: [identidade]};
      if (sql === comum.SQL_USAGE_PUBLIC) return {rows: [{usar_public: !semUsagePublic}]};
      if (sql === comum.SQL_ESTADO) {
        if (semUsagePublic) throw erroPg('42501', 'permission denied for schema public');
        if (objetosDepoisDe && ++leiturasEstado > objetosDepoisDe.n) atual.objetos = objetosDepoisDe.objetos;
        return {rows: [estado(atual.objetos, extra)]};
      }
      if (sql === comum.SQL_DOCUMENTOS) return {rows: [{documentos: 12}]};
      if (sql === comum.SQL_NOVAS) return {rows: [novas ?? NOVAS]};
      if (sql === comum.SQL_PRESERVACAO) return {rows: [preservacao ?? ZERO]};
      if (sql === comum.SQL_INDICES_INVALIDOS) return {rows: [{invalidos: invalidosNaTransacao ?? []}]};
      if (sql === C118) {
        assert.equal(ro, false, 'migration nunca em READ ONLY');
        pendente = {aplicar: () => { if (!naoCompleta) { atual.objetos = CHEIO; atual.aplicada = true; } }};
      }
      assert.notEqual(sql, M118, 'o arquivo COM o COMMIT final nunca é enviado');
      assert.ok(sql !== PRE118 && sql !== POS118, 'precheck/postcheck vão sem a própria moldura');
      return {rows: []};
    }
  };
  C.log = log; C.atual = atual;
  return C;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-118-'));
const semDisco = () => {};
const LEITURA = /^(BEGIN TRANSACTION READ ONLY|ROLLBACK|COMMIT|SET LOCAL|SELECT |\/\* (preservacao|indices)-118 \*\/ SELECT)/;
const escritas = log => log.filter(x => !x.ro && !LEITURA.test(x.sql) && !x.emTransacao);

test('hashes dos 3 SQL; migration é UMA transação enviada sem o COMMIT final, com os prazos do próprio SQL e só DDL nova', () => {
  for (const [, arquivo, hash] of comum.ETAPAS) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), hash, arquivo);
  assert.deepEqual(comum.ETAPAS.map(e => e[0]), PLANO_TUDO);
  assert.match(M118, /SET LOCAL lock_timeout = '5s';/); assert.match(M118, /SET LOCAL statement_timeout = '60s';/);
  assert.match(M118, /SET LOCAL search_path = public, pg_catalog;/);
  assert.doesNotMatch(M118.replace(/--.*$/gm, ''), /^\s*(UPDATE|DELETE|INSERT|TRUNCATE|COPY|ALTER|DROP)\b/im, 'nenhuma escrita de linha nem alteração de objeto existente');
  assert.equal(C118 + 'COMMIT;\n', M118, 'só o COMMIT final sai'); assert.doesNotMatch(C118, /^COMMIT;$/m);
  assert.throws(() => comum.semCommitFinal(M118 + 'COMMIT;\n', 'x'), /TRANSACAO_INESPERADA/);
  assert.throws(() => comum.semCommitFinal(M118.replace('BEGIN;\n', ''), 'x'), /TRANSACAO_INESPERADA/);
  for (const corpo of [CORPO_PRE, CORPO_POS]) { assert.match(corpo, /^SET LOCAL search_path = public, pg_catalog;\nDO \$\$/); assert.doesNotMatch(corpo, /^(BEGIN TRANSACTION|ROLLBACK;|COMMIT;)/m); }
  assert.throws(() => comum.corpoSomenteLeitura(POS118.replace('ROLLBACK;\n', 'COMMIT;\n'), 'x'), /MOLDURA_INESPERADA/);
  assert.throws(() => comum.corpoSomenteLeitura('BEGIN;\n' + POS118, 'x'), /MOLDURA_INESPERADA/);
  assert.throws(() => comum.corpoSomenteLeitura(POS118.replace('BEGIN TRANSACTION READ ONLY;\n', ''), 'x'), /MOLDURA_INESPERADA/);
  assert.throws(() => lerRevisado(raiz, comum.ETAPAS[1][1], 'f'.repeat(64)), /ARQUIVO_DIVERGENTE/);
});

test('os 7 objetos do estado são exatamente os que a 118 cria, o postcheck confere e o down remove; as 2 preservadas são as referenciadas', () => {
  assert.equal(comum.TOTAL_OBJETOS, 7);
  for (const t of comum.OBJETOS.tabelas) { assert.match(M118, new RegExp(`^CREATE TABLE ${t} \\(`, 'm')); assert.match(POS118, new RegExp(`"${t}": \\{`)); assert.match(DOWN118, new RegExp(`DROP TABLE public\\.${t};`)); }
  assert.equal((M118.match(/^CREATE TABLE /gm) ?? []).length, comum.OBJETOS.tabelas.length);
  for (const i of comum.OBJETOS.indices) { assert.match(M118, new RegExp(`^CREATE (?:UNIQUE )?INDEX ${i} ON ia_importacao_usos `, 'm')); assert.match(POS118, new RegExp(`"${i}": "CREATE (?:UNIQUE )?INDEX ${i} ON public\\.ia_importacao_usos`)); }
  // Todo índice explícito da 118 é das tabelas novas (somem com elas no down).
  assert.deepEqual([...M118.matchAll(/^CREATE (?:UNIQUE )?INDEX (\S+) ON (\S+)/gm)].map(m => [m[1], m[2]]),
    comum.OBJETOS.indices.map(i => [i, 'ia_importacao_usos']));
  const funcoes = [...M118.matchAll(/^CREATE FUNCTION ([a-z0-9_]+)\(/gm)].map(m => m[1]);
  assert.deepEqual(funcoes, comum.OBJETOS.funcoes.map(f => f.split('(')[0]));
  for (const f of comum.OBJETOS.funcoes) {
    assert.match(M118, new RegExp(`to_regprocedure\\('public\\.${f.replace(/[()]/g, '\\$&')}'\\)`), 'a guarda da migration usa a mesma assinatura: ' + f);
    assert.match(DOWN118, new RegExp(`DROP FUNCTION public\\.${f.split('(')[0]}\\(`), f);
  }
  // As tabelas existentes que a 118 toca são só as referenciadas pelas FKs novas — exatamente as preservadas.
  const referenciadas = [...M118.matchAll(/REFERENCES ([a-z_]+)\(/g)].map(m => m[1]).filter(t => !comum.OBJETOS.tabelas.includes(t));
  assert.deepEqual([...new Set(referenciadas)].sort(), [...comum.PRESERVADAS].sort());
});

test('estado só lê catálogo e privilégios (nenhuma tabela de dados); preservação lê xmin das 2 tabelas; contagens sem identificadores', () => {
  const sem = comum.SQL_ESTADO.replace(/'[^']*'/g, "''");
  assert.doesNotMatch(sem, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|TRUNCATE)\b/);
  const fontes = [...comum.SQL_ESTADO.matchAll(/\bFROM\s+([a-z_.]+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(fontes)].sort(), ['pg_class', 'pg_index', 'unnest'], 'só catálogo');
  assert.match(comum.SQL_ESTADO, /to_regprocedure\('public\.' \|\| f\)/);
  for (const sql of [comum.SQL_ESTADO, comum.SQL_INDICES_INVALIDOS]) {
    assert.match(sql, /NOT \(x\.indisvalid AND x\.indisready AND x\.indislive\)/);
    assert.match(sql, /x\.indrelid IN \(to_regclass\('public\.ia_importacao_cotas'\), to_regclass\('public\.ia_importacao_usos'\)\)/);
  }
  assert.doesNotMatch(comum.SQL_USAGE_PUBLIC, /to_regclass/, 'USAGE em public conferido sem resolver nome qualificado');
  for (const [rel, p, nome] of [['empresas', 'REFERENCES', 'referencias_empresas'], ['ia_documentos', 'REFERENCES', 'referencias_documentos'],
    ['empresas', 'SELECT', 'ler_empresas'], ['ia_documentos', 'SELECT', 'ler_documentos'], ['ia_importacao_cotas', 'SELECT', 'ler_cotas'], ['ia_importacao_usos', 'SELECT', 'ler_usos']]) {
    assert.match(comum.SQL_ESTADO, new RegExp(`has_table_privilege\\(current_user, oid, '${p}'\\) FROM pg_class WHERE oid = to_regclass\\('public\\.${rel}'\\)\\), false\\) AS ${nome}`));
  }
  assert.match(comum.SQL_ESTADO, /has_schema_privilege\(current_user, 'public', 'CREATE'\) AS pode_criar/);
  assert.match(comum.SQL_ESTADO, /has_language_privilege\(current_user, 'plpgsql', 'USAGE'\)/);
  assert.match(comum.SQL_ESTADO, /has_language_privilege\(current_user, 'sql', 'USAGE'\)/);
  for (const t of comum.PRESERVADAS) assert.match(comum.SQL_PRESERVACAO, new RegExp(`FROM public\\.${t} WHERE xmin::text = \\(pg_current_xact_id\\(\\)::text::bigint % 4294967296\\)::text\\)::int AS ${t}`));
  assert.doesNotMatch(comum.SQL_DOCUMENTOS + comum.SQL_NOVAS, /sha256|empresa_id|operacao_id|documento_id|conteudo|nome_original|\bid\b/);
});

test('estado e plano: 0 objetos = ausente; 7 = presente (postcheck); parcial recusa com os grupos; versão e privilégios de DDL só no ausente', () => {
  assert.equal(comum.lerEstado(estado()).m118, 'ausente');
  assert.equal(comum.lerEstado(estado(CHEIO)).m118, 'presente');
  const parcial = comum.lerEstado(estado({...CHEIO, funcoes: 2}));
  assert.equal(parcial.m118, 'parcial'); assert.deepEqual(parcial.divergencias, ['funcoes 2/3']);
  assert.throws(() => comum.lerEstado(estado(VAZIO, {referencias_documentos: 'sim'})), /ESTADO_ILEGIVEL referencias_documentos/);
  assert.throws(() => comum.lerEstado(estado({...VAZIO, tabelas: 3})), /ESTADO_ILEGIVEL tabelas/);
  assert.throws(() => comum.lerEstado(estado({...VAZIO, funcoes: 4})), /ESTADO_ILEGIVEL funcoes/);
  assert.throws(() => comum.lerEstado(estado({...VAZIO, indices: -1})), /ESTADO_ILEGIVEL indices/);
  assert.throws(() => comum.lerEstado(estado(VAZIO, {indices_invalidos: null})), /ESTADO_ILEGIVEL indices_invalidos/);
  assert.throws(() => comum.lerEstado(estado(VAZIO, {versao_pg: '18'})), /ESTADO_ILEGIVEL versao_pg/);
  const p = (objetos, extra) => comum.planoEtapas(comum.lerEstado(estado(objetos, extra)));
  assert.deepEqual(p(VAZIO), PLANO_TUDO);
  assert.deepEqual(p(CHEIO), ['postcheck 118']);
  for (const [o, e, re] of [[{...VAZIO, funcoes: 2}, {}, / APLICACAO_PARCIAL_118 tabelas 0\/2, indices 0\/2, funcoes 2\/3$/],
    [{...CHEIO, indices: 1}, {}, / APLICACAO_PARCIAL_118 indices 1\/2$/],
    [VAZIO, {empresas: false}, /TABELA_AUSENTE empresas$/], [CHEIO, {documentos: false}, /TABELA_AUSENTE ia_documentos$/],
    [VAZIO, {usar_public: false}, /SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC$/], [CHEIO, {ler_documentos: false}, /SEM_PRIVILEGIO_LEITURA SELECT_DOCUMENTOS$/],
    [VAZIO, {ler_empresas: false}, /SEM_PRIVILEGIO_LEITURA SELECT_EMPRESAS$/],
    [VAZIO, {versao_pg: 120017}, /VERSAO_PG_ANTIGA 120017$/],
    [VAZIO, {referencias_empresas: false}, /SEM_PRIVILEGIO_118 REFERENCES_EMPRESAS$/], [VAZIO, {referencias_documentos: false}, /SEM_PRIVILEGIO_118 REFERENCES_DOCUMENTOS$/],
    [VAZIO, {pode_criar: false}, /SEM_PRIVILEGIO_118 CREATE$/], [VAZIO, {linguagem_sql: false}, /SEM_PRIVILEGIO_118 LINGUAGEM_SQL$/],
    [VAZIO, {plpgsql: false, referencias_documentos: false}, /SEM_PRIVILEGIO_118 REFERENCES_DOCUMENTOS LINGUAGEM$/],
    [CHEIO, {ler_cotas: false}, /SEM_PRIVILEGIO_118_PRESENTE SELECT_COTAS$/], [CHEIO, {ler_usos: false}, /SEM_PRIVILEGIO_118_PRESENTE SELECT_USOS$/],
    [CHEIO, {plpgsql: false}, /SEM_PRIVILEGIO_118_PRESENTE LINGUAGEM$/],
    [CHEIO, {ler_cotas: false, ler_usos: false, plpgsql: false}, /SEM_PRIVILEGIO_118_PRESENTE SELECT_COTAS SELECT_USOS LINGUAGEM$/],
    [CHEIO, {indices_invalidos: ['ia_importacao_usos_vivo_uk']}, /INDICE_INVALIDO_118 ia_importacao_usos_vivo_uk$/],
    [CHEIO, {indices_invalidos: ['ia_importacao_cotas_pkey', 'ia_importacao_usos_periodo_idx']}, /INDICE_INVALIDO_118 ia_importacao_cotas_pkey ia_importacao_usos_periodo_idx$/]]) {
    assert.throws(() => p(o, e), re, JSON.stringify(e) + JSON.stringify(o));
  }
  assert.deepEqual(p(CHEIO, {referencias_empresas: false, referencias_documentos: false, pode_criar: false, linguagem_sql: false, versao_pg: 120017}), ['postcheck 118'],
    'REFERENCES/CREATE/sql/versão só com a 118 ausente');
  assert.deepEqual(p(VAZIO, {ler_cotas: false, ler_usos: false}), PLANO_TUDO, 'SELECT nas tabelas novas só com a 118 presente');
});

test('situação do COMMIT: 40003 e classes 08/57/58/XX ou sem SQLSTATE de resposta = INDETERMINADO; demais SQLSTATE = desfeita', () => {
  for (const [e, esperado] of [
    [erroNode('EPIPE'), 'INDETERMINADO'], [Object.assign(new Error('x'), {code: 'EPIPE'}), 'INDETERMINADO'], [erroNode('EPERM', 'connect'), 'INDETERMINADO'],
    [erroNode('ECONNRESET', 'read'), 'INDETERMINADO'], [Object.assign(new Error('x'), {code: '23505'}), 'INDETERMINADO'],
    [Object.assign(new Error('x'), {code: '23505', severity: 'ERROR', syscall: 'write'}), 'INDETERMINADO'], [erroPg('40003'), 'INDETERMINADO'],
    [erroPg('57014'), 'INDETERMINADO'], [erroPg('08006'), 'INDETERMINADO'], [erroPg('XX000'), 'INDETERMINADO'],
    [new Error('Connection terminated unexpectedly'), 'INDETERMINADO'], [erroPg('23505'), 'DESFEITA_PELO_SERVIDOR'], [erroPg('40P01'), 'DESFEITA_PELO_SERVIDOR']]) {
    assert.equal(comum.commitNaFalha(e), esperado, String(e.code ?? e.message));
  }
});

/**
 * Inventário conservador das variáveis de ambiente lidas por pg/lib/connection-parameters.js (parecer r1 da 116/117, P3).
 * Classifica: `process.env.NOME`, `process.env['NOME']` e os dois acessos dinâmicos do helper `val` (`'PG' + key` e
 * `envVar`, cujos nomes vêm das chamadas `val(...)`). Qualquer outra menção a `process`/`env` como acesso ao ambiente
 * (colchete dinâmico, `process[...]`, desestruturação, `require(process)`, enumeração) lança AMBIENTE_NAO_CLASSIFICADO.
 */
function inventarioAmbientePg(fonte) {
  const lidas = new Set();
  const DINAMICOS = ["process.env['PG' + key.toUpperCase()]", 'process.env[envVar]'];
  let resto = fonte; // fonte cru, sem remover comentários: menção em comentário reprova (fail-closed)
  for (const d of DINAMICOS) {
    const n = resto.split(d).length - 1;
    assert.ok(n <= 1, 'AMBIENTE_NAO_CLASSIFICADO acesso dinâmico repetido: ' + d);
    resto = resto.split(d).join(' ');
  }
  resto = resto.replace(/\bprocess\s*\.\s*env\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2\s*\])/g, (_, a, __, b) => {
    lidas.add(a ?? b); return ' ';
  });
  const sobra = resto.match(/\bprocess\b|\benv\b/);
  assert.ok(!sobra, 'AMBIENTE_NAO_CLASSIFICADO ' + (sobra ? resto.slice(Math.max(0, sobra.index - 30), sobra.index + 40) : ''));
  for (const [, chave, terceiro] of fonte.matchAll(/val\('([a-z_]+)', config(?:, ([^)]+))?\)/g)) {
    if (terceiro === undefined) lidas.add('PG' + chave.toUpperCase());
    else if (/^'[A-Z_]+'$/.test(terceiro.trim())) lidas.add(terceiro.trim().slice(1, -1));
    else assert.equal(terceiro.trim(), 'false', 'val com terceiro argumento desconhecido: ' + terceiro);
  }
  return lidas;
}

test('trava de alvo de staging e identidade: serviço, ambiente, host, banco, porta, URL sem query; mensagem sem segredos', async () => {
  assert.equal(stg.alvo(ENV_STG).application_name, 'kidmais-migration-118-staging');
  assert.equal(stg.alvo({...ENV_STG, DATABASE_SSL: 'true'}).ssl.rejectUnauthorized, true);
  for (const [mudanca, erro] of [[{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg'}, /SERVICO_RECUSADO/],
    [{RENDER_SERVICE_ID: 'srv-dblbmf6gekts73fubo9g'}, /SERVICO_RECUSADO/], [{KIDMAIS_DEPLOY_ENV: 'production'}, /AMBIENTE_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace('dpg-daidko3m8hqs73ce4jt0-a', 'dpg-outro.render.com')}, /HOST_RECUSADO/], [{DATABASE_URL: URL_STG.replace('kidmais_staging_1z91', 'kidmais_manager')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace(':5432', ':5433')}, /PORTA_RECUSADA/], [{DATABASE_URL: URL_STG + '?sslmode=disable'}, /CONNECTION_QUERY_REJECTED/],
    [{DATABASE_SSL: 'talvez'}, /TLS_CONFIGURACAO_RECUSADA/], [{DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false'}, /TLS_CONFIGURACAO_RECUSADA/],
    [{DATABASE_URL: 'nao-e-url'}, /URL_RECUSADA/], [{DATABASE_URL: URL_STG.replace('postgresql:', 'http:')}, /URL_RECUSADA/],
    [{DATABASE_URL: URL_STG + '#x'}, /CONNECTION_QUERY_REJECTED/], [{DATABASE_URL: URL_STG + '?'}, /CONNECTION_QUERY_REJECTED/],
    [{DATABASE_URL: URL_STG + '#'}, /CONNECTION_QUERY_REJECTED/], [{DATABASE_URL: URL_STG.replace('/kidmais', '?/kidmais')}, /CONNECTION_QUERY_REJECTED/],
    [{DATABASE_URL: undefined}, /CONNECTION_QUERY_REJECTED|URL_RECUSADA/], [{DATABASE_URL: URL_STG.replace('usuario:SENHA_FALSA@', '')}, /CREDENCIAL_AUSENTE_NA_URL/],
    [{DATABASE_URL: URL_STG.replace(':SENHA_FALSA@', '@')}, /CREDENCIAL_AUSENTE_NA_URL/],
    ...stg.PG_HERDADAS_RECUSADAS.map(n => [{[n]: '-c search_path=outro'}, new RegExp('AMBIENTE_PG_RECUSADO ' + n)])]) {
    assert.throws(() => stg.alvo({...ENV_STG, ...mudanca}), (e) => erro.test(e.message) && !e.message.includes('SENHA_FALSA'), JSON.stringify(mudanca));
  }
  assert.deepEqual(stg.PG_HERDADAS_RECUSADAS, ['PGOPTIONS', 'PGREPLICATION', 'PGBINARY', 'PGSSLNEGOTIATION', 'PGCLIENT_ENCODING', 'PGCLIENTENCODING']);
  // Parecer r2, P3: a lista é conferida contra o FONTE do pg instalado. Toda variável que connection-parameters.js lê do
  // ambiente é anulada pela configuração explícita (abaixo, com valor hostil) ou está na lista de recusa.
  const fonte = fs.readFileSync(require.resolve('pg/lib/connection-parameters'), 'utf8');
  // Parecer r1 da 116/117, P3: toda leitura de ambiente no fonte precisa ser classificada; acesso não reconhecido reprova.
  const lidas = inventarioAmbientePg(fonte);
  assert.ok(lidas.has('PGCLIENT_ENCODING') && lidas.has('PGOPTIONS') && lidas.has('PGSSLMODE'), 'leitura do fonte: ' + [...lidas]);
  // O inventário pega leitura nova por ponto ou por colchete com nome literal e reprova acesso dinâmico ou indireto.
  for (const [injecao, nome] of [["process.env['PGFUTURE_OPTIONS']", 'PGFUTURE_OPTIONS'], ['process.env["PGFUTURO"]', 'PGFUTURO'],
    ['process.env.PGFUTURO_PONTO', 'PGFUTURO_PONTO'], ['process . env [ \'PGESPACOS\' ]', 'PGESPACOS'],
    ['globalThis.process.env.PGGLOBAL', 'PGGLOBAL']]) {
    const alterado = fonte.split('  switch (process.env.PGSSLMODE) {').join('  void ' + injecao + '\n  switch (process.env.PGSSLMODE) {');
    assert.notEqual(alterado, fonte, 'âncora da injeção');
    assert.ok(inventarioAmbientePg(alterado).has(nome), 'injeção não detectada: ' + injecao);
  }
  for (const injecao of ['process.env[outra]', "process.env['PG' + x]", "process['env'].PGX", 'const {env} = process', "require('node:process')",
    'Object.keys(process.env)', 'env.PGSOLTO', 'process.env[envVar]']) {
    const alterado = fonte.split('  switch (process.env.PGSSLMODE) {').join('  void ' + injecao + '\n  switch (process.env.PGSSLMODE) {');
    assert.throws(() => inventarioAmbientePg(alterado), /AMBIENTE_NAO_CLASSIFICADO/, injecao);
  }
  const ANULADAS = ['PGUSER', 'PGDATABASE', 'PGPORT', 'PGHOST', 'PGPASSWORD', 'PGSSLMODE', 'PGAPPNAME', 'PGCONNECT_TIMEOUT'];
  for (const nome of lidas) assert.ok(ANULADAS.includes(nome) || stg.PG_HERDADAS_RECUSADAS.includes(nome), 'variável do pg sem tratamento: ' + nome);
  // NUL e controles no usuário ou na senha (parecer r2, P2): recusa ANTES de instanciar o cliente.
  const sujas = [['usuario%00options%00-c%20synchronous_commit%3Doff', 'SENHA_FALSA'], ['usuario', 'SENHA%00FALSA'], ['usu%0Aario', 'SENHA_FALSA'],
    ['usuario', 'SENHA%7FFALSA'], ['usu%1Fario', 'SENHA_FALSA']];
  for (const [usuario, senha] of sujas) {
    const envSujo = {...ENV_STG, DATABASE_URL: URL_STG.replace('usuario:SENHA_FALSA@', usuario + ':' + senha + '@')};
    assert.throws(() => stg.alvo(envSujo), (e) => /^CREDENCIAL_COM_CONTROLE$/.test(e.message), usuario + ':' + senha);
    let criados = 0;
    const Espia = class { constructor() { criados++; } on() {} async connect() {} async query() { return {rows: []}; } async end() {} };
    await assert.rejects(stg.conferir({env: envSujo, Client: Espia}), /CREDENCIAL_COM_CONTROLE/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r118-nul-'));
    try {
      await assert.rejects(stg.executar({env: envSujo, backup: 'PITR teste', dir, Client: Espia, disco: () => {}}), /CREDENCIAL_COM_CONTROLE/);
      assert.deepEqual(fs.readdirSync(dir), [], 'nada no disco');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    assert.equal(criados, 0, 'cliente nunca instanciado: ' + usuario);
  }
  // Configuração EFETIVA do pg (ConnectionParameters, o que o Client usa) com variáveis libpq hostis herdadas (parecer r1, P1):
  // URL sem porta + PGPORT=6543, PGHOST/PGDATABASE/PGUSER/PGPASSWORD trocados, PGSSLMODE=require com DATABASE_SSL=false.
  const ConnectionParameters = require('pg/lib/connection-parameters');
  const hostis = {PGPORT: '6543', PGHOST: 'dpg-outro', PGDATABASE: 'kidmais_manager', PGUSER: 'outro', PGPASSWORD: 'OUTRA', PGSSLMODE: 'require', PGAPPNAME: 'outro',
    PGCONNECT_TIMEOUT: '999'};
  assert.deepEqual(Object.keys(hostis).sort(), [...ANULADAS].sort(), 'toda variável anulada é exercitada com valor hostil');
  const guardado = Object.fromEntries(Object.keys(hostis).map(k => [k, process.env[k]]));
  Object.assign(process.env, hostis);
  try {
    for (const [ssl, esperado] of [['false', false], ['true', {rejectUnauthorized: true, minVersion: 'TLSv1.2'}]]) {
      const envUrl = {...ENV_STG, ...hostis, DATABASE_SSL: ssl, DATABASE_URL: URL_STG.replace(':5432', '')};
      const opts = stg.alvo(envUrl);
      assert.ok(!('connectionString' in opts), 'sem connectionString');
      assert.ok(!JSON.stringify(opts).includes('SENHA_FALSA'), 'senha fora da serialização');
      const p = new ConnectionParameters(opts);
      assert.deepEqual({host: p.host, port: p.port, database: p.database, user: p.user, password: p.password, ssl: p.ssl, app: p.application_name},
        {host: 'dpg-daidko3m8hqs73ce4jt0-a', port: 5432, database: 'kidmais_staging_1z91', user: 'usuario', password: 'SENHA_FALSA', ssl: esperado,
          app: 'kidmais-migration-118-staging'}, 'DATABASE_SSL=' + ssl);
      assert.equal(p.options, undefined); assert.ok(!p.replication); assert.ok(!p.binary); assert.equal(p.connect_timeout, 10);
    }
    const enc = new ConnectionParameters(stg.alvo({...ENV_STG, DATABASE_URL: 'postgres://us%40r:S%3AF@dpg-daidko3m8hqs73ce4jt0-a/kidmais_staging_1z91'}));
    assert.deepEqual([enc.user, enc.password, enc.port], ['us@r', 'S:F', 5432]);
  } finally {
    for (const [k, v] of Object.entries(guardado)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const outro = await stg.conferir({env: ENV_STG, Client: clienteFalso({identidade: {...ID_STG, db: 'outro_banco'}})});
  assert.equal(outro.resultado, 'FALHA'); assert.match(outro.mensagem, /IDENTIDADE_RECUSADA/); assert.ok(!JSON.stringify(outro).includes('SENHA_FALSA'));
  assert.equal(stg.DIR, '/opt/render/project/src/data/importacao-cotas-118-staging');
});

test('conferência: só leitura com search_path fixo, nada no disco; ausente = precheck; presente = postcheck; contagens', async () => {
  const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
  fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
  try {
    const Pronta = clienteFalso();
    const r = await stg.conferir({env: ENV_STG, Client: Pronta});
    assert.equal(r.resultado, 'PRONTA_PARA_APLICAR', JSON.stringify(r));
    assert.deepEqual(r.checks, {'precheck 118': 'PASS'}); assert.deepEqual(r.plano, PLANO_TUDO);
    assert.equal(r.estado.objetos, 0); assert.equal(r.dispensa, 'AUSENTE');
    assert.deepEqual(r.contagens, {documentos: 12});
    assert.deepEqual(escritas(Pronta.log), []);
    const leituras = Pronta.log.filter(x => /^SELECT|^SET LOCAL search_path = public, pg_catalog;\nDO/.test(x.sql));
    assert.ok(leituras.length > 0 && leituras.every(x => x.ro), 'toda consulta dentro de READ ONLY');
    assert.ok(Pronta.log.some(x => x.ro && x.sql === CORPO_PRE)); assert.ok(!Pronta.log.some(x => x.sql === C118 || x.sql === comum.SQL_NOVAS));
    assert.ok(Pronta.log.filter(x => x.sql === 'SET LOCAL search_path = public, pg_catalog').length >= 3);
    const Aplicada = clienteFalso({aplicada: true, novas: {cotas: 2, reservadas: 1, consumidas: 3, liberadas: 1}});
    const j = await stg.conferir({env: ENV_STG, Client: Aplicada});
    assert.equal(j.resultado, 'JA_APLICADA_POSTCHECK_PASS', JSON.stringify(j));
    assert.deepEqual(j.checks, {'postcheck 118': 'PASS'}); assert.deepEqual(j.contagens.novas, {cotas: 2, reservadas: 1, consumidas: 3, liberadas: 1}, 'linhas não recusam');
    assert.ok(Aplicada.log.some(x => x.ro && x.sql === CORPO_POS) && !Aplicada.log.some(x => x.sql === CORPO_PRE));
    assert.deepEqual(escritas(Aplicada.log), []);
  } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
  assert.deepEqual(gravacoes, [], 'a conferência não grava arquivos');
  for (const [opcoes, motivo, sohCatalogo] of [[{objetos: {...VAZIO, tabelas: 2}}, /APLICACAO_PARCIAL_118 tabelas 2\/2, indices 0\/2, funcoes 0\/3$|APLICACAO_PARCIAL_118 indices 0\/2, funcoes 0\/3$/, true],
    [{extra: {referencias_documentos: false}}, /SEM_PRIVILEGIO_118 REFERENCES_DOCUMENTOS/, true],
    [{falharEm: "'118 precheck: 055c ausente'", erro: erroPg('P0001', '118 precheck: 055c ausente')}, /118 precheck: 055c ausente/, false],
    [{aplicada: true, falharEm: "'118 postcheck: funções divergentes", erro: erroPg('P0001', '118 postcheck: funções divergentes: {}')}, /funções divergentes/, false]]) {
    const C = clienteFalso(opcoes);
    const x = await stg.principal(['--conferir-118'], ENV_STG, {Client: C});
    assert.equal(x.codigo, 3, JSON.stringify(x)); assert.equal(x.saida.resultado, 'RECUSARIA'); assert.match(x.saida.motivo, motivo);
    if (sohCatalogo) assert.ok(!C.log.some(y => y.sql === CORPO_PRE || y.sql === comum.SQL_DOCUMENTOS), 'nada lido além do catálogo');
  }
  assert.equal((await stg.principal(['--conferir-118'], ENV_STG, {Client: clienteFalso()})).codigo, 0);
  await assert.rejects(stg.principal(['--conferir-118'], {...ENV_STG, RENDER_SERVICE_ID: 'srv-x'}, {Client: clienteFalso()}), /SERVICO_RECUSADO/);
});

test('dispensa IMPORTACAO_COTA_DISPENSADA: só informada (nunca o valor), não muda plano, resultado nem aplicação', async () => {
  assert.equal(comum.estadoDispensa({}), 'AUSENTE'); assert.equal(comum.estadoDispensa({IMPORTACAO_COTA_DISPENSADA: ''}), 'AUSENTE');
  assert.equal(comum.estadoDispensa({...ENV_STG, IMPORTACAO_COTA_DISPENSADA: ENV_STG.RENDER_SERVICE_ID}), 'ESTE_SERVICO');
  assert.equal(comum.estadoDispensa({...ENV_STG, IMPORTACAO_COTA_DISPENSADA: 'true'}), 'OUTRO_VALOR');
  assert.equal(comum.estadoDispensa({IMPORTACAO_COTA_DISPENSADA: 'srv-x'}), 'OUTRO_VALOR');
  for (const [valor, informado] of [[ENV_STG.RENDER_SERVICE_ID, 'ESTE_SERVICO'], ['segredo-qualquer', 'OUTRO_VALOR']]) {
    const env = {...ENV_STG, IMPORTACAO_COTA_DISPENSADA: valor};
    const r = await stg.conferir({env, Client: clienteFalso()});
    assert.equal(r.resultado, 'PRONTA_PARA_APLICAR'); assert.equal(r.dispensa, informado); assert.ok(!JSON.stringify(r).includes('segredo-qualquer'));
    const dir = tmp();
    try {
      const a = await stg.executar({env, backup: BACKUP, dir, Client: clienteFalso(), disco: semDisco});
      assert.equal(a.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(a));
      const m = fs.readFileSync(a.marcador, 'utf8');
      assert.equal(JSON.parse(m).dispensa, informado); assert.ok(!m.includes('segredo-qualquer'));
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('aplicação: corpo sem COMMIT → preservação, índices e postcheck NA transação → COMMIT → postcheck READ ONLY; contagens; marcador', async () => {
  await assert.rejects(stg.principal(['--aplicar-118-autorizado'], ENV_STG, {Client: clienteFalso()}), /BACKUP_OBRIGATORIO/);
  await assert.rejects(stg.principal(['--aplicar-118-autorizado', '--backup', 'x;rm'], ENV_STG, {Client: clienteFalso()}), /BACKUP_INVALIDO/);
  await assert.rejects(stg.principal(['--aplicar-117-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso()}), /ARGUMENTOS_RECUSADOS/);
  await assert.rejects(stg.principal(['--conferir-118', '--extra'], ENV_STG, {Client: clienteFalso()}), /ARGUMENTOS_RECUSADOS/);
  const dir = tmp();
  try {
    const C = clienteFalso();
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r));
    assert.deepEqual(r.etapas, PLANO_TUDO); assert.deepEqual(r.commits, {118: 'CONFIRMADO'}); assert.deepEqual(r.commitadas, ['118']);
    assert.equal(r.estadoAntes.m118, 'ausente'); assert.equal(r.estadoDepois.m118, 'presente');
    assert.equal(r.contagensDepois.documentos, r.contagensAntes.documentos);
    assert.deepEqual(r.contagensDepois.novas, NOVAS); assert.equal(r.contagensAntes.novas, undefined);
    assert.deepEqual(escritas(C.log).map(x => x.sql), [C118], 'só o corpo (sem COMMIT) escreve');
    const i = C.log.findIndex(x => x.sql === C118), iCommit = C.log.findIndex((x, k) => k > i && x.sql === 'COMMIT');
    assert.ok(iCommit > i);
    const kPres = C.log.findIndex((x, n) => n > i && x.sql === comum.SQL_PRESERVACAO), kPos = C.log.findIndex((x, n) => n > i && x.sql === CORPO_POS);
    const kInd = C.log.findIndex((x, n) => n > i && x.sql === comum.SQL_INDICES_INVALIDOS);
    assert.ok(i < kPres && kPres < kInd && kInd < kPos && kPos < iCommit, 'preservação, índices, depois postcheck, antes do COMMIT');
    for (const k of [kPres, kInd, kPos]) assert.ok(C.log[k].emTransacao && !C.log[k].ro, 'na transação da migration');
    assert.equal(C.log[i - 1].sql, 'ROLLBACK', 'o corpo abre a própria transação logo depois da última leitura');
    assert.ok(C.log.slice(0, i).some(x => x.ro && x.sql === CORPO_PRE), 'precheck em READ ONLY antes');
    assert.ok(C.log.slice(iCommit + 1).some(x => x.ro && x.sql === CORPO_POS), 'postcheck de novo em READ ONLY depois do COMMIT');
    assert.ok(!C.log.some(x => /^SET statement_timeout|^RESET/.test(x.sql)), 'prazos só os do SQL (SET LOCAL)');
    const m = JSON.parse(fs.readFileSync(r.marcador, 'utf8'));
    assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.backup, BACKUP); assert.deepEqual(m.commits, {118: 'CONFIRMADO'}); assert.equal(m.dispensa, 'AUSENTE');
    assert.deepEqual(m.etapas.find(e => e.nome === 'migration 118').antesDoCommit, {preservacao: 'PASS', indices: 'PASS', 'postcheck 118': 'PASS'});
    assert.ok(C.log.findIndex(x => x.sql === comum.SQL_USAGE_PUBLIC) < C.log.findIndex(x => x.sql === comum.SQL_ESTADO), 'USAGE antes do estado');
    assert.ok(!fs.readFileSync(r.marcador, 'utf8').includes('SENHA_FALSA'));
    await assert.rejects(stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: clienteFalso(), disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('preservação divergente DENTRO da transação (linha de qualquer das 2 tabelas escrita): ROLLBACK, nada confirmado', async () => {
  for (const preservacao of [...comum.PRESERVADAS.map(t => ({...ZERO, [t]: 1})), {}]) {
    const dir = tmp();
    try {
      const C = clienteFalso({preservacao});
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /PRESERVACAO_118 empresas=/);
      assert.deepEqual(r.commits, {118: 'NAO_COMMITADA'}); assert.deepEqual(r.commitadas, []);
      const i = C.log.findIndex(x => x.sql === C118);
      assert.ok(!C.log.slice(i).some(x => x.sql === 'COMMIT'), 'COMMIT nunca enviado'); assert.ok(C.log.slice(i).some(x => x.sql === 'ROLLBACK'));
      assert.ok(!C.log.slice(i).some(x => x.sql === CORPO_POS), 'postcheck nem chega a rodar');
      assert.equal(C.atual.aplicada, false, 'nada confirmado');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('situação do COMMIT na aplicação: corpo/verificação = NAO_COMMITADA; COMMIT 40003/08/57/sem resposta/EPIPE = INDETERMINADO; recusa = desfeita', async () => {
  const casos = [
    ['corpo (lock_timeout na FK para empresas)', {falharEm: 'CREATE TABLE ia_importacao_cotas', erro: erroPg('55P03')}, 'NAO_COMMITADA'],
    ['corpo (lock_timeout na FK para ia_documentos)', {falharEm: 'CREATE TABLE ia_importacao_usos', erro: erroPg('55P03')}, 'NAO_COMMITADA'],
    ['corpo (conexão caiu)', {falharEm: 'CREATE FUNCTION kidmais_118_guarda', erro: new Error('Connection terminated unexpectedly')}, 'NAO_COMMITADA'],
    ['corpo (statement_timeout do SQL)', {falharEm: 'CREATE UNIQUE INDEX', erro: erroPg('57014', 'canceling statement due to statement timeout')}, 'NAO_COMMITADA'],
    ['preservação (conexão caiu)', {falharEm: 'preservacao-118', erro: erroPg('08006')}, 'NAO_COMMITADA'],
    ['postcheck na transação', {falharEm: "'118 postcheck: definição das tabelas novas divergente", erro: erroPg('P0001')}, 'NAO_COMMITADA'],
    ['índice inválido na transação', {invalidosNaTransacao: ['ia_importacao_usos_vivo_uk']}, 'NAO_COMMITADA'],
    ['COMMIT 40003', {falharCommit: {n: 1, erro: erroPg('40003')}}, 'INDETERMINADO'],
    ['COMMIT 08006', {falharCommit: {n: 1, erro: erroPg('08006')}}, 'INDETERMINADO'],
    ['COMMIT 57014', {falharCommit: {n: 1, erro: erroPg('57014')}}, 'INDETERMINADO'],
    ['COMMIT sem resposta', {falharCommit: {n: 1, erro: new Error('Connection terminated unexpectedly')}}, 'INDETERMINADO'],
    ['COMMIT com EPIPE (transporte)', {falharCommit: {n: 1, erro: erroNode('EPIPE')}}, 'INDETERMINADO'],
    ['COMMIT recusado (23514)', {falharCommit: {n: 1, erro: erroPg('23514')}}, 'DESFEITA_PELO_SERVIDOR'],
    ['COMMIT respondido como ROLLBACK', {falharCommit: {n: 1, rollback: true}}, 'DESFEITA_PELO_SERVIDOR'],
  ];
  for (const [rotulo, opcoes, commit] of casos) {
    const dir = tmp();
    try {
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: clienteFalso(opcoes), disco: semDisco});
      assert.equal(r.resultado, 'FALHA', rotulo + JSON.stringify(r)); assert.deepEqual(r.commits, {118: commit}, rotulo);
      assert.equal(r.falha.etapa, 'migration 118', rotulo); assert.match(r.reconciliar, /--conferir-118/);
      const m = JSON.parse(fs.readFileSync(r.marcador, 'utf8'));
      assert.equal(m.situacao, 'FALHA'); assert.deepEqual(m.commits, {118: commit}, rotulo + ' (marcador)');
      await assert.rejects(stg.principal(['--aplicar-118-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso(), dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('retomada autorizada: COMMIT indeterminado que confirmou; marcador renomeado → nova execução só roda o postcheck', async () => {
  const dir = tmp();
  try {
    const r1 = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: clienteFalso({falharCommit: {n: 1, erro: erroPg('08006')}}), disco: semDisco});
    assert.deepEqual(r1.commits, {118: 'INDETERMINADO'});
    fs.renameSync(path.join(dir, comum.MARCADOR), path.join(dir, 'migration-118.2026-11-08T22-00.json'));
    const C2 = clienteFalso({aplicada: true, extra: {referencias_empresas: false, referencias_documentos: false, pode_criar: false}});
    const r2 = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C2, disco: semDisco});
    assert.equal(r2.resultado, 'JA_APLICADA_POSTCHECK_PASS', JSON.stringify(r2)); assert.deepEqual(r2.etapas, ['postcheck 118']); assert.deepEqual(r2.commits, {});
    assert.deepEqual(escritas(C2.log), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8')).tentativasAnteriores, ['migration-118.2026-11-08T22-00.json']);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('estado que não completa depois do COMMIT, deriva depois do postcheck, recusas antes de escrever e disco ausente', async () => {
  for (const [opcoes, motivo, commits] of [[{naoCompleta: true}, /ESTADO_DEPOIS_118/, {118: 'CONFIRMADO'}],
    [{aplicada: true, objetosDepoisDe: {n: 1, objetos: {...CHEIO, funcoes: 2}}}, /ESTADO_FINAL_118/, {}],
    [{objetos: {...VAZIO, funcoes: 1}}, /APLICACAO_PARCIAL_118 tabelas 0\/2, indices 0\/2, funcoes 1\/3$/, {}], [{extra: {pode_criar: false}}, /SEM_PRIVILEGIO_118 CREATE/, {}],
    [{extra: {referencias_empresas: false}}, /SEM_PRIVILEGIO_118 REFERENCES_EMPRESAS/, {}], [{extra: {versao_pg: 120017}}, /VERSAO_PG_ANTIGA/, {}],
    [{semUsagePublic: true}, /^SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC$/, {}]]) {
    const dir = tmp();
    try {
      const C = clienteFalso(opcoes);
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'FALHA', JSON.stringify(r)); assert.match(r.falha.mensagem, motivo); assert.deepEqual(r.commits, commits);
      if (!commits[118]) assert.deepEqual(escritas(C.log), [], 'recusa antes de qualquer escrita');
      if (opcoes.semUsagePublic) assert.ok(!C.log.some(y => y.sql === comum.SQL_ESTADO), 'o estado (to_regclass qualificado) nunca é enviado');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
  const dir1 = tmp();
  try { await assert.rejects(stg.executar({env: ENV_STG, backup: BACKUP, dir: dir1, Client: clienteFalso(), disco: () => assert.fail('DISCO_PERSISTENTE_AUSENTE')}), /DISCO_PERSISTENTE_AUSENTE/);
    assert.deepEqual(fs.readdirSync(dir1), [], 'sem disco, nenhum marcador');
    for (const backup of [undefined, '', 'curto', 'x;rm -rf /', 'PITR ok\nx']) {
      const C = clienteFalso();
      await assert.rejects(stg.executar({env: ENV_STG, backup, dir: dir1, Client: C, disco: semDisco}), /BACKUP_OBRIGATORIO/, JSON.stringify(backup));
      assert.deepEqual(C.log, [], 'nada enviado ao banco');
    }
    assert.deepEqual(fs.readdirSync(dir1), [], 'backup recusado, nenhum marcador'); }
  finally { fs.rmSync(dir1, {recursive: true, force: true}); }
  const dir2 = tmp();
  try {
    const x = await stg.principal(['--aplicar-118-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso({falharEm: 'CREATE TABLE ia_importacao_usos'}), dir: dir2, disco: semDisco});
    assert.equal(x.codigo, 2); assert.equal(x.saida.resultado, 'FALHA');
  } finally { fs.rmSync(dir2, {recursive: true, force: true}); }
  // Conferência sem USAGE em public: recusa nominal (código 3), sem o estado.
  const C = clienteFalso({semUsagePublic: true});
  const x = await stg.principal(['--conferir-118'], ENV_STG, {Client: C});
  assert.equal(x.codigo, 3, JSON.stringify(x)); assert.match(x.saida.motivo, /^SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC$/);
  assert.ok(!C.log.some(y => y.sql === comum.SQL_ESTADO));
});

test('SQL revisado divergente: plano, conferência e aplicação recusam antes de conectar ou de ler o banco', async () => {
  const outra = fs.mkdtempSync(path.join(os.tmpdir(), 'raiz-118-'));
  try {
    for (const [, a] of comum.ETAPAS) { fs.mkdirSync(path.dirname(path.join(outra, a)), {recursive: true}); fs.copyFileSync(path.join(raiz, a), path.join(outra, a)); }
    fs.appendFileSync(path.join(outra, comum.ETAPAS[1][1]), '\n-- alterado\n');
    assert.throws(() => stg.plano({raiz: outra}), /ARQUIVO_DIVERGENTE database\/migrations\/20261104_118/);
    const dir = tmp();
    try {
      await assert.rejects(stg.executar({env: ENV_STG, backup: BACKUP, dir, raiz: outra, Client: clienteFalso(), disco: semDisco}), /ARQUIVO_DIVERGENTE/);
      assert.deepEqual(fs.readdirSync(dir), [], 'nenhum marcador');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    fs.copyFileSync(path.join(raiz, comum.ETAPAS[1][1]), path.join(outra, comum.ETAPAS[1][1]));
    fs.appendFileSync(path.join(outra, comum.ETAPAS[0][1]), '\n-- alterado\n');
    const C = clienteFalso();
    const r = await stg.conferir({env: ENV_STG, raiz: outra, Client: C});
    assert.equal(r.resultado, 'RECUSARIA', JSON.stringify(r)); assert.match(r.motivo, /ARQUIVO_DIVERGENTE database\/checks\/20261104_118_precheck/);
    assert.ok(!C.log.some(x => x.sql === CORPO_PRE), 'precheck divergente nunca enviado');
  } finally { fs.rmSync(outra, {recursive: true, force: true}); }
});

test('plano sem conexão: 3 SQL com sha, prova no alvo, prazos do SQL, ordem com PITR e autorização, paradas; nunca o down nem a dispensa', async () => {
  const {codigo, saida} = await stg.principal([], {});
  assert.equal(codigo, 0); assert.equal(saida.conecta, false); assert.equal(saida.ambiente, 'staging');
  assert.deepEqual(saida.arquivos.map(a => a.sha256), comum.ETAPAS.map(e => e[2]));
  assert.match(saida.provaNoAlvo, /preservação/); assert.match(saida.provaNoAlvo, /antes do COMMIT/); assert.match(saida.provaNoAlvo, /ia_documentos/);
  assert.match(saida.prazos, /lock_timeout 5 s e statement_timeout 60 s do próprio SQL/);
  assert.ok(saida.ordem.some(o => /PITR/.test(o)) && saida.ordem.some(o => /autorização de Felipe para a 118/.test(o)) && saida.ordem.some(o => /imediatamente antes/.test(o)));
  assert.ok(saida.ordem.some(o => /sem importação em andamento/.test(o)) && saida.ordem.some(o => /COTA_INDISPONIVEL/.test(o)));
  assert.ok(saida.preRequisitos.some(p => /REFERENCES em empresas e em ia_documentos/.test(p)) && saida.preRequisitos.some(p => /#354/.test(p)));
  assert.ok(saida.paradas.some(p => /nunca apagar/.test(p)) && saida.paradas.some(p => /INDETERMINADO/.test(p)));
  assert.ok(saida.recuperacao.some(r => /sem nenhuma leitura contada/.test(r)) && saida.recuperacao.some(r => /CONTRACT_IMPORT/.test(r)) && saida.recuperacao.some(r => /PITR/.test(r)));
  assert.ok(saida.nuncaExecuta.includes('down 118') && saida.nuncaExecuta.includes('ligar ou remover IMPORTACAO_COTA_DISPENSADA'));
  assert.ok(!saida.arquivos.some(a => a.arquivo.includes('rollback')));
  assert.equal(JSON.stringify(saida).includes('DATABASE_URL'), false);
});
