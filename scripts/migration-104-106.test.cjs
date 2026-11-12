/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 104/106 (hash da revisão com o salão e salão de preferência, staging) com cliente simulado que só CONFIRMA
// no COMMIT e descarta no ROLLBACK (plano rev. 2 aprovado pelo Astra em 27/10/2026): hashes e moldura de uma transação;
// catálogo/privilégios num só SELECT sem cast antecipado; estados com precedência (104 divergente > parcial; presença ×
// integridade); privilégios por etapa e só para o estado encontrado; atividade pelas pg_locks com contexto (ressalva da
// rev. 2: visibilidade insuficiente recusa); ordem das consultas (nada de dados antes das guardas); verificações DO dentro
// da transação, antes do COMMIT, inclusive o EXECUTE das funções novas; situação do COMMIT por migration (40003, ROLLBACK
// respondido, 106 falhando com a 104 confirmada); auditoria de dados da 104 separada da integridade; marcador e retomada.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const comum = require('./migration-104-106-comum.cjs');
const {lerRevisado} = require('./migration-092-094-comum.cjs');
const stg = require('./migration-104-106-staging.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_STG = 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91';
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false', DATABASE_URL: URL_STG});
const ID_STG = {db: 'kidmais_staging_1z91', tls: false, servidor_privado: true};
const BACKUP = 'PITR 27/10 21:00Z ref-1';
const ler = nome => { const [, a, h] = comum.ETAPAS.find(e => e[0] === nome); return lerRevisado(raiz, a, h); };
const M104 = ler('migration 104'), M106 = ler('migration 106');
const C104 = comum.semCommitFinal(M104, 'm104'), C106 = comum.semCommitFinal(M106, 'm106');
const X104 = comum.sqlExecucao('104'), X106 = comum.sqlExecucao('106');
const erroPg = (code, msg = 'erro simulado') => Object.assign(new Error(msg), {code});
const COMPLETA_104 = {m104_marcadores: 4, hash_corpo: comum.CORPO_HASH_104};
const COMPLETA_106 = {m106_marcadores: 7};
const PRIVILEGIOS = ['usar_public', 'pode_criar', 'temp', 'plpgsql', 'linguagem_sql', 'ler_revisoes', 'ler_revisao_adicionais', 'ler_fechamentos', 'ler_saloes',
  'executar_hash', 'dono_revisoes', 'dono_hash', 'gatilho_revisoes', 'travar_revisoes', 'dono_fechamentos', 'dono_saloes', 'gatilho_fechamentos', 'gatilho_saloes',
  'referencias_saloes', 'ver_atividade'];
const estado = (extra = {}) => ({versao_pg: 180006, d104: true, hash_corpo: comum.CORPO_HASH_016, hash_meta: true, m104_marcadores: 0, d106: true, m106_marcadores: 0,
  ...Object.fromEntries(PRIVILEGIOS.map(p => [p, true])), papel_trocado: true, ...extra});
const SEM_ATIVIDADE = {locks: 0, sessoes: 0, sessoes_em_transacao: 0, locks_sem_pid: 0, sem_contexto: 0};
const CONTAGENS = {revisoes: 4, revisoes_v2: null, fechamentos_com_preferencia: null, saloes: 3};

/**
 * Cliente simulado transacional: o corpo da migration (sem COMMIT) deixa o efeito PENDENTE; 'COMMIT' confirma e
 * 'ROLLBACK' descarta. Opções: falharEm (trecho → lança `erro`; com soNaTransacao, só dentro da transação da migration);
 * falharCommit {n, erro} ou {n, rollback: true}; atividade; executa (EXECUTE das funções novas); naoCompleta (id).
 */
function clienteFalso({inicial = estado(), identidade = ID_STG, falharEm, soNaTransacao = false, erro, falharCommit, atividade = SEM_ATIVIDADE, executa = true, naoCompleta} = {}) {
  const log = []; let ro = false, pendente = null, commits = 0;
  const atual = {...inicial};
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') ro = true;
      log.push({sql, ro, emTransacao: pendente !== null});
      if (falharEm && sql.includes(falharEm) && (!soNaTransacao || pendente)) { if (pendente) pendente.abortada = true; throw erro ?? erroPg('P0001', 'falha simulada em ' + falharEm); }
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
      if (sql === comum.SQL_ESTADO) return {rows: [{...atual}]};
      if (sql === comum.SQL_ATIVIDADE) return {rows: [{...atividade}]};
      if (sql.includes('AS saloes')) return {rows: [{...CONTAGENS}]};
      if (sql === X104) return {rows: [{executa_104: executa}]};
      if (sql === X106) return {rows: [{executa_106: executa}]};
      if (sql === C104) { assert.equal(ro, false, 'migration nunca em READ ONLY'); pendente = {aplicar: () => { if (naoCompleta !== '104') Object.assign(atual, COMPLETA_104); }}; }
      if (sql === C106) { assert.equal(ro, false, 'migration nunca em READ ONLY'); pendente = {aplicar: () => { if (naoCompleta !== '106') Object.assign(atual, COMPLETA_106); }}; }
      assert.ok(sql !== M104 && sql !== M106, 'o arquivo COM o COMMIT final nunca é enviado');
      return {rows: []};
    }
  };
  C.log = log; C.atual = atual;
  return C;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-104-106-'));
const semDisco = () => {};
const escritas = log => log.filter(x => !x.ro && !/^(BEGIN TRANSACTION READ ONLY|ROLLBACK|COMMIT|SET LOCAL)/.test(x.sql) && !x.emTransacao);
const PLANO_TUDO = ['precheck 104', 'migration 104', 'integridade 104', 'postcheck 104', 'precheck 106', 'migration 106', 'postcheck 106', 'integridade 106'];
const leuDados = C => C.log.some(x => x.sql === comum.SQL_ATIVIDADE || x.sql.includes('AS saloes') || comum.ETAPAS.some(([n]) => x.sql === ler(n)));

test('hashes dos 8 SQL; migrations de UMA transação enviadas sem o COMMIT; 106 sem postcheck interno; integridade 104 só de catálogo', () => {
  for (const [, arquivo, hash] of comum.ETAPAS) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), hash, arquivo);
  }
  assert.deepEqual(comum.ETAPAS.map(e => e[0]), PLANO_TUDO);
  for (const [m, c] of [[M104, C104], [M106, C106]]) {
    assert.match(m, /SET LOCAL lock_timeout = '5s'/); assert.match(m, /SET LOCAL search_path = public, pg_catalog;/);
    assert.equal(c + 'COMMIT;\n', m, 'só o COMMIT final sai'); assert.doesNotMatch(c, /^COMMIT;$/m); assert.match(c, /^BEGIN;$/m);
  }
  assert.throws(() => comum.semCommitFinal(M106 + 'COMMIT;\n', 'x'), /TRANSACAO_INESPERADA/);
  assert.throws(() => comum.semCommitFinal(C106, 'x'), /TRANSACAO_INESPERADA/);
  assert.throws(() => comum.semCommitFinal(M104.replace('BEGIN;\n', ''), 'x'), /TRANSACAO_INESPERADA/);
  // P2-1 do parecer da rev. 1: a 106 não verifica nada depois do último CREATE TRIGGER — o aplicador verifica antes do COMMIT.
  assert.doesNotMatch(M106, /postcheck/); assert.match(C106, /CREATE TRIGGER agenda_saloes_106_escopo_trg[\s\S]*;\n$/);
  assert.match(M104, /104: postcheck falhou \(hash de revisão existente mudou\)/, 'a 104 prova a preservação dos hashes dentro dela');
  const i104 = ler('integridade 104'), p104 = ler('postcheck 104');
  assert.doesNotMatch(i104, /FROM public\./, 'integridade da 104 não lê dados'); assert.match(p104, /FROM public\.fechamento_revisoes r/, 'a auditoria lê');
  for (const trecho of [comum.CORPO_HASH_104, '182ead96ac34a0abcd6251d500bb3b5705657301fe915a6addd19f82b432ec85', "pg_get_constraintdef(c.oid) = 'CHECK ((hash_versao = ANY (ARRAY[1, 2])))'",
    'p.prokind::text AS kind', 'NOT p.prosecdef AS invoker']) assert.ok(i104.includes(trecho) && p104.includes(trecho), trecho);
  assert.match(ler('integridade 106'), /106 integridade: preferência fora da empresa ou unidade da festa/);
  assert.ok(ler('precheck 104').includes(comum.CORPO_HASH_016));
  assert.throws(() => lerRevisado(raiz, comum.ETAPAS[1][1], 'f'.repeat(64)), /ARQUIVO_DIVERGENTE/);
});

test('SQL_ESTADO: só catálogo, sem nenhum ::regclass de objeto que pode faltar; privilégios de cada etapa de current_user', () => {
  const sem = comum.SQL_ESTADO.replace(/'[^']*'/g, "''");
  assert.doesNotMatch(sem, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|TRUNCATE)\b/);
  const fontes = [...new Set([...comum.SQL_ESTADO.matchAll(/\bFROM\s+([a-z_.]+)/g)].map(m => m[1]))].sort();
  assert.deepEqual(fontes, ['pg_attribute', 'pg_class', 'pg_constraint', 'pg_language', 'pg_proc', 'pg_roles', 'pg_trigger'], 'só catálogo');
  assert.doesNotMatch(comum.SQL_ESTADO, /'public\.[a-z_0-9()]+'::reg(class|procedure)/, 'sem cast antecipado');
  for (const t of ['fechamento_revisoes', 'fechamento_revisao_adicionais', 'fechamentos', 'agenda_saloes', 'agenda_salao_fotos', 'fechamentos_106_salao_preferido_idx']) {
    assert.ok(comum.SQL_ESTADO.includes(`to_regclass('public.${t}')`), t);
  }
  const priv = (t, p) => `has_table_privilege(current_user, oid, '${p}') FROM pg_class WHERE oid = to_regclass('public.${t}')`;
  for (const p of ['SELECT', 'TRIGGER', 'UPDATE', 'DELETE', 'TRUNCATE', 'MAINTAIN']) assert.ok(comum.SQL_ESTADO.includes(priv('fechamento_revisoes', p)), 'fechamento_revisoes ' + p);
  for (const [t, p] of [['fechamento_revisao_adicionais', 'SELECT'], ['fechamentos', 'SELECT'], ['fechamentos', 'TRIGGER'], ['agenda_saloes', 'SELECT'], ['agenda_saloes', 'TRIGGER']]) {
    assert.ok(comum.SQL_ESTADO.includes(priv(t, p)), t + ' ' + p);
  }
  for (const c of ['empresa_id', 'id']) assert.match(comum.SQL_ESTADO, new RegExp(`has_column_privilege\\(current_user, attrelid, attnum, 'REFERENCES'\\) FROM pg_attribute\\s+WHERE attrelid = to_regclass\\('public\\.agenda_saloes'\\) AND attname = '${c}'`));
  assert.match(comum.SQL_ESTADO, /has_database_privilege\(current_user, current_database\(\), 'TEMP'\) AS temp/);
  assert.match(comum.SQL_ESTADO, /has_function_privilege\(current_user, to_regprocedure\('public\.kidmais_hash_revisao_operacional\(uuid\)'\), 'EXECUTE'\)/);
  assert.match(comum.SQL_ESTADO, /pg_has_role\(current_user, proowner, 'USAGE'\) FROM pg_proc WHERE oid = to_regprocedure\('public\.kidmais_hash_revisao_operacional\(uuid\)'\)/);
  for (const t of ['fechamento_revisoes', 'fechamentos', 'agenda_saloes']) assert.ok(comum.SQL_ESTADO.includes(`pg_has_role(current_user, relowner, 'USAGE') FROM pg_class WHERE oid = to_regclass('public.${t}')`), 'dono ' + t);
  assert.match(comum.SQL_ESTADO, /WHEN current_setting\('server_version_num'\)::int >= 170000 THEN coalesce\(\(SELECT has_table_privilege\(current_user, oid, 'MAINTAIN'\)/);
  assert.match(comum.SQL_ESTADO, /pg_has_role\(current_user, 'pg_read_all_stats', 'USAGE'\)\) AS ver_atividade/);
  assert.match(comum.SQL_ESTADO, /p\.provolatile = 's' AND p\.proconfig IS NULL\s+AND NOT p\.prosecdef AND p\.prorettype = 'text'::regtype AND p\.prokind = 'f'/, 'metadados da função de hash');
  assert.match(comum.SQL_ATIVIDADE, /FROM pg_locks l LEFT JOIN pg_stat_activity a ON a\.pid = l\.pid/);
  assert.match(comum.SQL_ATIVIDADE, /l\.pid IS DISTINCT FROM pg_backend_pid\(\)/, 'P2-C1: lock com pid NULL (transação preparada) não é descartado');
  assert.doesNotMatch(comum.SQL_ATIVIDADE, /l\.pid <> /);
  assert.match(comum.SQL_ATIVIDADE, /count\(\*\) FILTER \(WHERE l\.pid IS NULL\)::int AS locks_sem_pid/);
  assert.match(comum.SQL_ATIVIDADE, /\+ count\(\*\) FILTER \(WHERE l\.pid IS NULL\)\)::int AS sem_contexto/, 'locks sem pid contam como sem contexto');
  for (const f of ['kidmais104_hash_versao_imutavel()', 'kidmais106_salao_preferido_escopo()', 'kidmais106_salao_escopo_referenciado()']) {
    assert.ok((X104 + X106).includes(`has_function_privilege(current_user, to_regprocedure('public.${f}'), 'EXECUTE')`), f);
  }
});

test('estados: 104 ausente/completa/parcial/divergente (precedência e metadados); 106 ausente/completa/parcial; ilegível recusa', () => {
  const m104 = e => comum.lerEstado(estado(e)).m104, m106 = e => comum.lerEstado(estado(e)).m106;
  assert.equal(m104({}), 'ausente'); assert.equal(m104(COMPLETA_104), 'completa');
  for (const p of [{m104_marcadores: 1}, {m104_marcadores: 3}, {m104_marcadores: 4}, {hash_corpo: comum.CORPO_HASH_104}, {...COMPLETA_104, m104_marcadores: 2}]) {
    assert.equal(m104(p), 'parcial', JSON.stringify(p));
  }
  for (const p of [{hash_corpo: null}, {hash_corpo: 'a'.repeat(64)}, {hash_meta: false}, {...COMPLETA_104, hash_meta: false}, {m104_marcadores: 2, hash_corpo: null}]) {
    assert.equal(m104(p), 'divergente', JSON.stringify(p) + ': divergente vence parcial');
  }
  assert.equal(m106({}), 'ausente'); assert.equal(m106(COMPLETA_106), 'completa');
  for (const n of [1, 3, 6]) assert.equal(m106({m106_marcadores: n}), 'parcial', String(n));
  assert.throws(() => comum.lerEstado(estado({temp: 'sim'})), /ESTADO_ILEGIVEL temp/);
  assert.throws(() => comum.lerEstado(estado({m104_marcadores: 5})), /ESTADO_ILEGIVEL m104_marcadores/);
  assert.throws(() => comum.lerEstado(estado({m106_marcadores: 8})), /ESTADO_ILEGIVEL m106_marcadores/);
  assert.throws(() => comum.lerEstado(estado({hash_corpo: 'xyz'})), /ESTADO_ILEGIVEL hash_corpo/);
  assert.throws(() => comum.lerEstado(estado({versao_pg: '18'})), /ESTADO_ILEGIVEL versao_pg/);
});

test('plano: combinações e recusas nomeadas; privilégios só para o estado encontrado; completas sem permissões de DDL', () => {
  const p = e => comum.planoEtapas(comum.lerEstado(estado(e)));
  assert.deepEqual(p({}), PLANO_TUDO);
  assert.deepEqual(p(COMPLETA_104), ['integridade 104', 'postcheck 104', 'precheck 106', 'migration 106', 'postcheck 106', 'integridade 106'], 'modelo 105: só a 106');
  assert.deepEqual(p(COMPLETA_106), ['precheck 104', 'migration 104', 'integridade 104', 'postcheck 104', 'integridade 106']);
  assert.deepEqual(p({...COMPLETA_104, ...COMPLETA_106}), ['integridade 104', 'postcheck 104', 'integridade 106']);
  for (const [e, re] of [
    [{d104: false}, /SEM_DEPENDENCIA_104/], [{d106: false}, /SEM_DEPENDENCIA_106/], [{hash_corpo: null}, /FUNCAO_HASH_DIVERGENTE_104/],
    [{hash_meta: false}, /FUNCAO_HASH_DIVERGENTE_104/], [{m104_marcadores: 2}, /APLICACAO_PARCIAL_104/], [{m106_marcadores: 5}, /APLICACAO_PARCIAL_106/],
    [{usar_public: false}, /SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC$/], [{plpgsql: false}, /SEM_PRIVILEGIO_LEITURA PLPGSQL$/],
    [{ler_revisao_adicionais: false}, /SEM_PRIVILEGIO_LEITURA SELECT_FECHAMENTO_REVISAO_ADICIONAIS$/], [{executar_hash: false}, /SEM_PRIVILEGIO_LEITURA EXECUTE_HASH$/],
    [{temp: false}, /SEM_PRIVILEGIO_104 TEMP$/], [{dono_hash: false}, /SEM_PRIVILEGIO_104 DONO_FUNCAO_HASH$/], [{dono_revisoes: false}, /SEM_PRIVILEGIO_104 DONO_FECHAMENTO_REVISOES$/],
    [{gatilho_revisoes: false}, /SEM_PRIVILEGIO_104 TRIGGER$/], [{travar_revisoes: false}, /SEM_PRIVILEGIO_104 LOCK$/], [{linguagem_sql: false}, /SEM_PRIVILEGIO_104 LINGUAGEM_SQL$/],
    [{...COMPLETA_104, dono_fechamentos: false}, /SEM_PRIVILEGIO_106 DONO_FECHAMENTOS$/], [{...COMPLETA_104, dono_saloes: false}, /SEM_PRIVILEGIO_106 DONO_AGENDA_SALOES$/],
    [{...COMPLETA_104, gatilho_fechamentos: false}, /SEM_PRIVILEGIO_106 TRIGGER_FECHAMENTOS$/], [{...COMPLETA_104, gatilho_saloes: false}, /SEM_PRIVILEGIO_106 TRIGGER_AGENDA_SALOES$/],
    [{...COMPLETA_104, referencias_saloes: false}, /SEM_PRIVILEGIO_106 REFERENCES$/], [{...COMPLETA_104, pode_criar: false}, /SEM_PRIVILEGIO_106 CREATE$/],
    [{ver_atividade: false}, /ATIVIDADE_NAO_VERIFICAVEL/]]) {
    assert.throws(() => p(e), re, JSON.stringify(e));
  }
  assert.throws(() => p({pode_criar: false, temp: false}), /SEM_PRIVILEGIO_104 CREATE TEMP$/, 'várias faltas listadas');
  const ddl = Object.fromEntries(['pode_criar', 'temp', 'linguagem_sql', 'dono_revisoes', 'dono_hash', 'gatilho_revisoes', 'travar_revisoes', 'dono_fechamentos', 'dono_saloes',
    'gatilho_fechamentos', 'gatilho_saloes', 'referencias_saloes', 'ver_atividade'].map(k => [k, false]));
  assert.deepEqual(p({...COMPLETA_104, ...COMPLETA_106, ...ddl}), ['integridade 104', 'postcheck 104', 'integridade 106'], 'completas: só leitura exigida');
  assert.deepEqual(p({...COMPLETA_104, temp: false, dono_hash: false, travar_revisoes: false}).at(-1), 'integridade 106', 'privilégios da 104 só com ela pendente');
  assert.deepEqual(p({...COMPLETA_106, dono_fechamentos: false, referencias_saloes: false}).at(0), 'precheck 104', 'privilégios da 106 só com ela pendente');
});

test('atividade: nenhuma outra sessão com lock nas tabelas; sem contexto visível recusa como não verificável; ilegível recusa', () => {
  assert.doesNotThrow(() => comum.exigirSemAtividade(SEM_ATIVIDADE));
  assert.throws(() => comum.exigirSemAtividade({...SEM_ATIVIDADE, locks: 2, sessoes: 1, sessoes_em_transacao: 1}), /ATIVIDADE_NAS_TABELAS 1 sessão\(ões\), 1 em transação, 2 lock\(s\)/);
  assert.throws(() => comum.exigirSemAtividade({...SEM_ATIVIDADE, locks: 1, sessoes: 1, sem_contexto: 1}), /ATIVIDADE_NAO_VERIFICAVEL 1/, 'sem contexto vence: nunca vira ausência');
  assert.throws(() => comum.exigirSemAtividade({...SEM_ATIVIDADE, sessoes: null}), /ESTADO_ILEGIVEL atividade sessoes/);
  // P2-C1: transação preparada — lock sem pid, nenhuma sessão: recusa como não verificável (nunca PRONTA).
  assert.throws(() => comum.exigirSemAtividade({...SEM_ATIVIDADE, locks: 1, locks_sem_pid: 1, sem_contexto: 1}), /ATIVIDADE_NAO_VERIFICAVEL 1 sem contexto visível \(1 lock\(s\) sem pid: transação preparada\)/);
  assert.throws(() => comum.exigirSemAtividade({...SEM_ATIVIDADE, locks_sem_pid: undefined}), /ESTADO_ILEGIVEL atividade locks_sem_pid/);
});

test('situação do COMMIT: 40003 e classes 08/57/58/XX ou sem SQLSTATE = INDETERMINADO; demais SQLSTATE = desfeita', () => {
  for (const [e, esperado] of [[erroPg('40003'), 'INDETERMINADO'], [erroPg('57014'), 'INDETERMINADO'], [erroPg('08006'), 'INDETERMINADO'], [erroPg('58030'), 'INDETERMINADO'],
    [erroPg('XX000'), 'INDETERMINADO'], [new Error('Connection terminated unexpectedly'), 'INDETERMINADO'], [erroPg('23503'), 'DESFEITA_PELO_SERVIDOR'],
    [erroPg('40001'), 'DESFEITA_PELO_SERVIDOR'], [erroPg('40P01'), 'DESFEITA_PELO_SERVIDOR']]) {
    assert.equal(comum.commitNaFalha(e), esperado, String(e.code ?? e.message));
  }
});

test('trava de alvo de staging e identidade: serviço, ambiente, host, banco, porta, URL sem query; mensagem sem segredos', async () => {
  assert.equal(stg.alvo(ENV_STG).application_name, 'kidmais-migration-104-106-staging');
  for (const [mudanca, erro] of [[{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg'}, /SERVICO_RECUSADO/], [{KIDMAIS_DEPLOY_ENV: 'production'}, /AMBIENTE_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace('dpg-daidko3m8hqs73ce4jt0-a', 'dpg-outro.render.com')}, /HOST_RECUSADO/], [{DATABASE_URL: URL_STG.replace('kidmais_staging_1z91', 'kidmais_manager')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace(':5432', ':5433')}, /PORTA_RECUSADA/], [{DATABASE_URL: URL_STG + '?sslmode=disable'}, /CONNECTION_QUERY_REJECTED/],
    [{DATABASE_SSL: 'talvez'}, /TLS_CONFIGURACAO_RECUSADA/]]) {
    assert.throws(() => stg.alvo({...ENV_STG, ...mudanca}), (e) => erro.test(e.message) && !e.message.includes('SENHA_FALSA'));
  }
  const outro = await stg.conferir({env: ENV_STG, Client: clienteFalso({identidade: {...ID_STG, db: 'outro_banco'}})});
  assert.equal(outro.resultado, 'FALHA'); assert.ok(!JSON.stringify(outro).includes('SENHA_FALSA'));
  assert.equal(stg.DIR, '/opt/render/project/src/data/saloes-104-106-staging');
});

test('conferência: só leitura com search_path fixo, nada no disco; ordem catálogo → guardas → atividade → dados; recusas sem ler dados', async () => {
  const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
  fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
  try {
    const Pronta = clienteFalso();
    const r = await stg.conferir({env: ENV_STG, Client: Pronta});
    assert.equal(r.resultado, 'PRONTA_PARA_APLICAR', JSON.stringify(r));
    assert.deepEqual(r.checks, {'precheck 104': 'PASS', 'precheck 106': 'PASS'}); assert.deepEqual(r.plano, PLANO_TUDO);
    assert.deepEqual(r.atividade, SEM_ATIVIDADE); assert.deepEqual(r.contagens, CONTAGENS);
    assert.deepEqual(escritas(Pronta.log), []);
    const leituras = Pronta.log.filter(x => /^SELECT|^DO|^--/.test(x.sql));
    assert.ok(leituras.length > 0 && leituras.every(x => x.ro), 'toda consulta dentro de READ ONLY');
    assert.equal(Pronta.log.filter(x => x.sql === 'SET LOCAL search_path = public, pg_catalog').length, leituras.length, 'search_path fixo em toda leitura');
    const ordem = s => Pronta.log.findIndex(x => x.sql === s || (typeof s === 'function' && s(x.sql)));
    assert.ok(ordem(comum.SQL_ESTADO) < ordem(comum.SQL_ATIVIDADE) && ordem(comum.SQL_ATIVIDADE) < ordem(q => q.includes('AS saloes'))
      && ordem(q => q.includes('AS saloes')) < ordem(ler('precheck 104')), 'catálogo → atividade → contagens → checks');
    const Aplicada = clienteFalso({inicial: estado({...COMPLETA_104, ...COMPLETA_106, ver_atividade: false})});
    const j = await stg.conferir({env: ENV_STG, Client: Aplicada});
    assert.equal(j.resultado, 'JA_APLICADA_INTEGRIDADE_PASS', JSON.stringify(j));
    assert.deepEqual(j.checks, {'integridade 104': 'PASS', 'postcheck 104': 'PASS', 'integridade 106': 'PASS'});
    assert.ok(!Aplicada.log.some(x => x.sql === comum.SQL_ATIVIDADE), 'nada pendente: atividade nem lida');
    assert.deepEqual(escritas(Aplicada.log), []);
  } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
  assert.deepEqual(gravacoes, [], 'a conferência não grava arquivos');
  for (const [e, motivo] of [[{hash_corpo: null}, /FUNCAO_HASH_DIVERGENTE_104/], [{m106_marcadores: 3}, /APLICACAO_PARCIAL_106/], [{temp: false}, /SEM_PRIVILEGIO_104 TEMP/],
    [{referencias_saloes: false}, /SEM_PRIVILEGIO_106 REFERENCES/], [{ver_atividade: false}, /ATIVIDADE_NAO_VERIFICAVEL/], [{d106: false}, /SEM_DEPENDENCIA_106/]]) {
    const C = clienteFalso({inicial: estado(e)});
    const x = await stg.principal(['--conferir-104-106'], ENV_STG, {Client: C});
    assert.equal(x.codigo, 3, JSON.stringify(x)); assert.equal(x.saida.resultado, 'RECUSARIA'); assert.match(x.saida.motivo, motivo);
    assert.ok(!leuDados(C), 'nada lido além do catálogo: ' + JSON.stringify(e));
  }
  for (const [atividade, motivo] of [[{...SEM_ATIVIDADE, locks: 3, sessoes: 2, sessoes_em_transacao: 1}, /ATIVIDADE_NAS_TABELAS 2/], [{...SEM_ATIVIDADE, locks: 1, sessoes: 1, sem_contexto: 1}, /ATIVIDADE_NAO_VERIFICAVEL 1/],
    [{...SEM_ATIVIDADE, locks: 2, locks_sem_pid: 2, sem_contexto: 2}, /ATIVIDADE_NAO_VERIFICAVEL 2 .*transação preparada/]]) {
    const C = clienteFalso({atividade});
    const x = await stg.principal(['--conferir-104-106'], ENV_STG, {Client: C});
    assert.equal(x.codigo, 3); assert.match(x.saida.motivo, motivo);
    assert.ok(!C.log.some(q => q.sql.includes('AS saloes') || q.sql === ler('precheck 104')), 'atividade recusa antes das contagens e checks');
  }
  for (const [opcoes, motivo] of [[{inicial: estado({...COMPLETA_104, ...COMPLETA_106}), falharEm: '104 integridade:'}, /INTEGRIDADE_104/],
    [{inicial: estado({...COMPLETA_104, ...COMPLETA_106}), falharEm: 'r.estado IN'}, /AUDITORIA_DADOS_104/], [{inicial: estado({...COMPLETA_104, ...COMPLETA_106}), falharEm: '106 integridade:'}, /INTEGRIDADE_106/],
    [{falharEm: '106 precheck:'}, /falha simulada em 106 precheck/]]) {
    const x = await stg.principal(['--conferir-104-106'], ENV_STG, {Client: clienteFalso(opcoes)});
    assert.equal(x.codigo, 3, JSON.stringify(x)); assert.match(x.saida.motivo, motivo);
    assert.notEqual(x.saida.resultado, 'JA_APLICADA_INTEGRIDADE_PASS', 'completa com integridade falha nunca é JA_APLICADA');
  }
  await assert.rejects(stg.principal(['--conferir-104-106'], {...ENV_STG, RENDER_SERVICE_ID: 'srv-x'}, {Client: clienteFalso()}), /SERVICO_RECUSADO/);
});

test('aplicação: corpo sem COMMIT → verificações (com EXECUTE das funções novas) NA transação → COMMIT → READ ONLY; 104 antes da 106', async () => {
  await assert.rejects(stg.principal(['--aplicar-104-106-autorizado'], ENV_STG, {Client: clienteFalso()}), /BACKUP_OBRIGATORIO/);
  await assert.rejects(stg.principal(['--aplicar-104-106-autorizado', '--backup', 'x;rm'], ENV_STG, {Client: clienteFalso()}), /BACKUP_INVALIDO/);
  await assert.rejects(stg.principal(['--aplicar-102-103-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso()}), /ARGUMENTOS_RECUSADOS/);
  const dir = tmp();
  try {
    const C = clienteFalso();
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r));
    assert.deepEqual(r.etapas, PLANO_TUDO); assert.deepEqual(r.commits, {104: 'CONFIRMADO', 106: 'CONFIRMADO'}); assert.deepEqual(r.commitadas, ['104', '106']);
    assert.deepEqual(escritas(C.log).map(x => x.sql), [C104, C106], 'só os corpos (sem COMMIT) escrevem, na ordem');
    for (const [corpo, verifs] of [[C104, ['integridade 104', X104]], [C106, ['postcheck 106', 'integridade 106', X106]]]) {
      const i = C.log.findIndex(x => x.sql === corpo), iCommit = C.log.findIndex((x, k) => k > i && x.sql === 'COMMIT');
      for (const v of verifs) {
        const sql = v.startsWith('SELECT') ? v : ler(v);
        const k = C.log.findIndex((x, n) => n > i && x.sql === sql);
        assert.ok(k > i && k < iCommit && C.log[k].emTransacao && !C.log[k].ro, (v.startsWith('SELECT') ? 'execucao' : v) + ' dentro da transação, antes do COMMIT');
      }
    }
    const iAtividade = C.log.findIndex(x => x.sql === comum.SQL_ATIVIDADE);
    assert.ok(iAtividade > 0 && iAtividade < C.log.findIndex(x => x.sql === C104), 'atividade lida antes da primeira escrita');
    assert.ok(C.log.some((x, k) => k > C.log.findIndex(y => y.sql === C104) && x.ro && x.sql === ler('postcheck 104')), 'auditoria da 104 em READ ONLY depois do COMMIT');
    const m = JSON.parse(fs.readFileSync(r.marcador, 'utf8'));
    assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.backup, BACKUP); assert.deepEqual(m.commits, {104: 'CONFIRMADO', 106: 'CONFIRMADO'});
    assert.deepEqual(m.etapas.find(e => e.nome === 'migration 106').antesDoCommit, {'postcheck 106': 'PASS', 'integridade 106': 'PASS', 'execucao 106': 'PASS'});
    assert.ok(!fs.readFileSync(r.marcador, 'utf8').includes('SENHA_FALSA'));
    await assert.rejects(stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: clienteFalso(), disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('aplicação parcial do plano: só a 106 (104 completa, modelo 105) ou só a 104 (106 completa)', async () => {
  for (const [inicial, etapas, corpos] of [[estado(COMPLETA_104), ['integridade 104', 'postcheck 104', 'precheck 106', 'migration 106', 'postcheck 106', 'integridade 106'], [C106]],
    [estado(COMPLETA_106), ['precheck 104', 'migration 104', 'integridade 104', 'postcheck 104', 'integridade 106'], [C104]]]) {
    const dir = tmp();
    try {
      const C = clienteFalso({inicial});
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS'); assert.deepEqual(r.etapas, etapas);
      assert.deepEqual(escritas(C.log).map(x => x.sql), corpos);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('falha nas verificações ANTES do COMMIT: ROLLBACK, NAO_COMMITADA, nada confirmado; a 106 não roda se a 104 falhar', async () => {
  for (const [opcoes, motivo, commits, estadoFinal] of [
    [{falharEm: '104 integridade:', soNaTransacao: true}, /INTEGRIDADE_104/, {104: 'NAO_COMMITADA'}, {m104: 'ausente', m106: 'ausente'}],
    [{executa: false}, /EXECUCAO_FUNCOES_104/, {104: 'NAO_COMMITADA'}, {m104: 'ausente', m106: 'ausente'}],
    [{falharEm: '106 integridade: preferência', soNaTransacao: true}, /INTEGRIDADE_106/, {104: 'CONFIRMADO', 106: 'NAO_COMMITADA'}, {m104: 'completa', m106: 'ausente'}],
    [{inicial: estado(COMPLETA_104), executa: false}, /EXECUCAO_FUNCOES_106/, {106: 'NAO_COMMITADA'}, {m104: 'completa', m106: 'ausente'}]]) {
    const dir = tmp();
    try {
      const C = clienteFalso(opcoes);
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'FALHA', JSON.stringify(r)); assert.match(r.falha.mensagem, motivo); assert.deepEqual(r.commits, commits);
      const s = comum.lerEstado(C.atual);
      assert.deepEqual({m104: s.m104, m106: s.m106}, estadoFinal, 'nada confirmado além do registrado');
      if (commits['104'] === 'NAO_COMMITADA') assert.ok(!C.log.some(x => x.sql === C106), 'a 106 não roda');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('situação por migration: corpo = NAO_COMMITADA; COMMIT 40003/08/sem resposta INDETERMINADO, recusa desfeita, ROLLBACK respondido; 106 com a 104 confirmada', async () => {
  const casos = [
    ['corpo 104 (lock)', {falharEm: 'LOCK TABLE public.fechamento_revisoes', erro: erroPg('55P03')}, {104: 'NAO_COMMITADA'}],
    ['corpo 104 (conexão caiu)', {falharEm: 'CREATE TEMP TABLE', erro: new Error('Connection terminated unexpectedly')}, {104: 'NAO_COMMITADA'}],
    ['COMMIT 104 40003', {falharCommit: {n: 1, erro: erroPg('40003')}}, {104: 'INDETERMINADO'}],
    ['COMMIT 104 08006', {falharCommit: {n: 1, erro: erroPg('08006')}}, {104: 'INDETERMINADO'}],
    ['COMMIT 104 sem resposta', {falharCommit: {n: 1, erro: new Error('Connection terminated unexpectedly')}}, {104: 'INDETERMINADO'}],
    ['COMMIT 104 recusado (23514)', {falharCommit: {n: 1, erro: erroPg('23514')}}, {104: 'DESFEITA_PELO_SERVIDOR'}],
    ['COMMIT 104 respondido como ROLLBACK', {falharCommit: {n: 1, rollback: true}}, {104: 'DESFEITA_PELO_SERVIDOR'}],
    ['corpo 106 (lock em fechamentos)', {falharEm: 'ALTER TABLE public.fechamentos ADD COLUMN salao_preferido_id', erro: erroPg('55P03')}, {104: 'CONFIRMADO', 106: 'NAO_COMMITADA'}],
    ['COMMIT 106 40003', {falharCommit: {n: 2, erro: erroPg('40003')}}, {104: 'CONFIRMADO', 106: 'INDETERMINADO'}],
    ['COMMIT 106 respondido como ROLLBACK', {falharCommit: {n: 2, rollback: true}}, {104: 'CONFIRMADO', 106: 'DESFEITA_PELO_SERVIDOR'}],
  ];
  for (const [rotulo, opcoes, commits] of casos) {
    const dir = tmp();
    try {
      const C = clienteFalso(opcoes);
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'FALHA', rotulo + JSON.stringify(r)); assert.deepEqual(r.commits, commits, rotulo);
      assert.match(r.reconciliar, /--conferir-104-106/);
      const m = JSON.parse(fs.readFileSync(r.marcador, 'utf8'));
      assert.equal(m.situacao, 'FALHA'); assert.deepEqual(m.commits, commits, rotulo + ' (marcador)');
      if (!('106' in commits)) assert.ok(!C.log.some(x => x.sql === C106), rotulo + ': 106 não roda');
      await assert.rejects(stg.principal(['--aplicar-104-106-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso(), dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('falha DEPOIS de um COMMIT confirmado não vira desfeita: auditoria da 104 e integridade da 106 em READ ONLY', async () => {
  for (const [opcoes, motivo, commits] of [[{falharEm: 'r.estado IN'}, /AUDITORIA_DADOS_104/, {104: 'CONFIRMADO'}],
    [{naoCompleta: '104'}, /ESTADO_DEPOIS_104/, {104: 'CONFIRMADO'}], [{naoCompleta: '106'}, /ESTADO_DEPOIS_106/, {104: 'CONFIRMADO', 106: 'CONFIRMADO'}]]) {
    const dir = tmp();
    try {
      const C = clienteFalso(opcoes);
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, motivo); assert.deepEqual(r.commits, commits);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('retomada autorizada: 106 falhou com a 104 confirmada; marcador renomeado → nova execução confere a 104 e aplica só a 106', async () => {
  const dir = tmp();
  try {
    const C1 = clienteFalso({falharEm: 'ALTER TABLE public.fechamentos ADD COLUMN salao_preferido_id', erro: erroPg('55P03')});
    const r1 = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C1, disco: semDisco});
    assert.deepEqual(r1.commits, {104: 'CONFIRMADO', 106: 'NAO_COMMITADA'});
    fs.renameSync(path.join(dir, comum.MARCADOR), path.join(dir, 'migration-104-106.2026-10-27T22-00.json'));
    const C2 = clienteFalso({inicial: {...C1.atual}});
    const r2 = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C2, disco: semDisco});
    assert.equal(r2.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r2));
    assert.deepEqual(r2.etapas, ['integridade 104', 'postcheck 104', 'precheck 106', 'migration 106', 'postcheck 106', 'integridade 106']); assert.deepEqual(r2.commits, {106: 'CONFIRMADO'});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8')).tentativasAnteriores, ['migration-104-106.2026-10-27T22-00.json']);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('mudança entre conferência e aplicação: catálogo ou atividade recusam antes de qualquer escrita; já aplicadas não escrevem', async () => {
  for (const opcoes of [{inicial: estado({m106_marcadores: 2})}, {inicial: estado({travar_revisoes: false})}, {atividade: {...SEM_ATIVIDADE, locks: 1, sessoes: 1, sessoes_em_transacao: 1}},
    {atividade: {...SEM_ATIVIDADE, locks: 1, locks_sem_pid: 1, sem_contexto: 1}}]) {
    const dir = tmp();
    try {
      const C = clienteFalso(opcoes);
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'FALHA', JSON.stringify(opcoes)); assert.deepEqual(r.commits, {}); assert.deepEqual(escritas(C.log), []);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
  const dir = tmp();
  try {
    const C = clienteFalso({inicial: estado({...COMPLETA_104, ...COMPLETA_106})});
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'JA_APLICADA_INTEGRIDADE_PASS'); assert.deepEqual(r.etapas, ['integridade 104', 'postcheck 104', 'integridade 106']);
    assert.deepEqual(escritas(C.log), []); assert.deepEqual(r.commits, {});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  await assert.rejects(stg.executar({env: ENV_STG, backup: BACKUP, dir: tmp(), Client: clienteFalso(), disco: () => assert.fail('DISCO_PERSISTENTE_AUSENTE')}), /DISCO_PERSISTENTE_AUSENTE/);
});

test('plano sem conexão: 8 arquivos com sha, pré-requisitos por etapa, janela e locks, paradas e recuperação; nunca os down nem a flag', async () => {
  const {codigo, saida} = await stg.principal([], {});
  assert.equal(codigo, 0); assert.equal(saida.conecta, false); assert.equal(saida.ambiente, 'staging');
  assert.deepEqual(saida.arquivos.map(a => a.sha256), comum.ETAPAS.map(e => e[2]));
  assert.deepEqual(saida.funcaoHash, {corpo016: comum.CORPO_HASH_016, corpo104: comum.CORPO_HASH_104});
  assert.ok(saida.preRequisitos.some(p => /TEMP/.test(p) && /LOCK/.test(p)) && saida.preRequisitos.some(p => /REFERENCES em agenda_saloes\(empresa_id, id\)/.test(p))
    && saida.preRequisitos.some(p => /pg_read_all_stats/.test(p)) && saida.preRequisitos.some(p => /105/.test(p) && /fictício/.test(p)));
  assert.ok(saida.ordem.some(o => /janela drenada/.test(o) && /lock_timeout 5s só limita a espera/.test(o) && /ACCESS EXCLUSIVE em fechamentos/.test(o)));
  assert.ok(saida.ordem.some(o => /PITR/.test(o) && /NÃO substitui/.test(o)) && saida.ordem.some(o => /imediatamente antes/.test(o) && /pg_locks/.test(o)));
  assert.ok(saida.paradas.some(p => /NAO_COMMITADA/.test(p) && /INDETERMINADO/.test(p)) && saida.paradas.some(p => /falha na 106 com a 104 confirmada/.test(p))
    && saida.paradas.some(p => /marcador incompleto ou ilegível/.test(p) && /processo interrompido/.test(p)) && saida.paradas.some(p => /nunca apagar/.test(p)));
  for (const n of ['down 104', 'down 106', 'ligar SALOES_PUBLICOS']) assert.ok(saida.nuncaExecuta.includes(n), n);
  assert.ok(!saida.arquivos.some(a => a.arquivo.includes('rollback')));
});
