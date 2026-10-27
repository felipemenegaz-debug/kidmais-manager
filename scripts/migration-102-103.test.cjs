/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 102/103 (apresentação do salão e categoria Serviços, staging) com cliente simulado que só CONFIRMA no COMMIT
// e descarta no ROLLBACK: hashes, estado em duas leituras (catálogo/privilégios e, só depois das guardas, a linha SERVICOS),
// 098, versão do PostgreSQL do retrato, privilégios um a um, trava de alvo, conferência só leitura com search_path fixo,
// migration sem o COMMIT final com postcheck/integridade na transação (retrato divergente = nada confirmado), situação do
// COMMIT por migration (NAO_COMMITADA / CONFIRMADO / DESFEITA_PELO_SERVIDOR / INDETERMINADO, inclusive 40003 e a 103
// falhando com a 102 confirmada), marcador anti-repetição e retomada pelo marcador renomeado. Sem rede nem banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const comum = require('./migration-102-103-comum.cjs');
const {lerRevisado} = require('./migration-092-094-comum.cjs');
const stg = require('./migration-102-103-staging.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_STG = 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91';
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false', DATABASE_URL: URL_STG});
const ID_STG = {db: 'kidmais_staging_1z91', tls: false, servidor_privado: true};
const BACKUP = 'export 27/10 12:00Z';
const ler = nome => { const [, a, h] = comum.ETAPAS.find(e => e[0] === nome); return lerRevisado(raiz, a, h); };
const M102 = ler('migration 102'), M103 = ler('migration 103'), I102 = ler('integridade 102');
const C102 = comum.semCommitFinal(M102, 'm102'), C103 = comum.semCommitFinal(M103, 'm103');
const erroPg = (code, msg = 'erro simulado') => Object.assign(new Error(msg), {code});
const COMPLETA_102 = {m102_colunas: 13, m102_tabelas: 3, m102_funcoes: 9};
const estado = (extra = {}) => ({versao_pg: 180006, d102: true, d103: true, m102_colunas: 0, m102_tabelas: 0, m102_funcoes: 0, com_098: false,
  usar_public: true, pode_criar: true, ler_saloes: true, ler_102: true, dono_102: true, gatilho_102: true, referencias_102: true, linguagens_102: true, plpgsql: true,
  ler_103: true, inserir_103: true, travar_103: true, papel_trocado: true, ...extra});
const CONTAGENS = {saloes: 3, saloes_ativos: 2, categorias_adicionais: 9};

/**
 * Cliente simulado transacional: o corpo da migration (sem COMMIT) deixa o efeito PENDENTE; 'COMMIT' confirma e
 * 'ROLLBACK' descarta. SQL_ESTADO/SQL_CATEGORIA_103 devolvem o estado CONFIRMADO. Opções:
 *   falharEm: trecho de uma consulta que lança `erro`; falharCommit: {n: N-ésimo COMMIT, erro} ou {n, rollback: true};
 *   integra: integra_102 fora da transação; integraNaTransacao: integra_102 dentro da transação da migration;
 *   linha: m103_linha inicial; naoCompleta: id cuja migration "confirma" sem mudar o estado.
 */
function clienteFalso({inicial = estado(), linha = 'AUSENTE', identidade = ID_STG, falharEm, erro, falharCommit, integra = true, integraNaTransacao = true, naoCompleta} = {}) {
  const log = []; let ro = false, pendente = null, commits = 0;
  const atual = {...inicial}; const cat = {linha};
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
      if (sql === comum.SQL_ESTADO) return {rows: [{...atual}]};
      if (sql === comum.SQL_CATEGORIA_103) return {rows: [{m103_linha: cat.linha}]};
      if (sql.includes('AS categorias_adicionais')) return {rows: [{...CONTAGENS}]};
      if (sql === I102) return {rows: [{integra_102: pendente ? integraNaTransacao : integra}]};
      if (sql === C102) { assert.equal(ro, false, 'migration nunca em READ ONLY'); pendente = {aplicar: () => { if (naoCompleta !== '102') Object.assign(atual, COMPLETA_102); }}; }
      if (sql === C103) { assert.equal(ro, false, 'migration nunca em READ ONLY'); pendente = {aplicar: () => { if (naoCompleta !== '103') cat.linha = 'IGUAL'; }}; }
      assert.ok(sql !== M102 && sql !== M103, 'o arquivo COM o COMMIT final nunca é enviado');
      return {rows: []};
    }
  };
  C.log = log; C.atual = atual; C.cat = cat;
  return C;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-102-103-'));
const semDisco = () => {};
const escritas = log => log.filter(x => !x.ro && !/^(BEGIN TRANSACTION READ ONLY|ROLLBACK|COMMIT|SET LOCAL)/.test(x.sql) && !x.emTransacao);
const PLANO_TUDO = ['precheck 102', 'migration 102', 'postcheck 102', 'integridade 102', 'precheck 103', 'migration 103', 'postcheck 103'];
const leuCategoria = C => C.log.some(x => x.sql === comum.SQL_CATEGORIA_103);

test('hashes dos 7 SQL; cada migration é UMA transação terminando em COMMIT, enviada sem ele; retrato igual nos SQL', () => {
  for (const [, arquivo, hash] of comum.ETAPAS) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), hash, arquivo);
  }
  assert.deepEqual(comum.ETAPAS.map(e => e[0]), PLANO_TUDO);
  for (const [m, c] of [[M102, C102], [M103, C103]]) {
    assert.match(m, /SET LOCAL lock_timeout = '5s'/); assert.match(m, /SET LOCAL search_path = public, pg_catalog;/);
    assert.equal(c + 'COMMIT;\n', m, 'só o COMMIT final sai'); assert.doesNotMatch(c, /^COMMIT;$/m); assert.match(c, /^BEGIN;$/m);
  }
  assert.throws(() => comum.semCommitFinal(M102 + 'COMMIT;\n', 'x'), /TRANSACAO_INESPERADA/);
  assert.throws(() => comum.semCommitFinal(C102, 'x'), /TRANSACAO_INESPERADA/);
  assert.throws(() => comum.semCommitFinal(M102.replace('BEGIN;\n', ''), 'x'), /TRANSACAO_INESPERADA/);
  for (const nome of ['postcheck 102', 'integridade 102']) assert.ok(ler(nome).includes(comum.RETRATO_102), nome);
  assert.ok(fs.readFileSync(path.join(raiz, 'database/rollback/20261025_102_saloes_apresentacao_down.sql'), 'utf8').includes(comum.RETRATO_102));
  assert.match(I102, /AS integra_102;\s*$/);
  for (const c of comum.COLUNAS_102) assert.ok(ler('precheck 102').includes(`'${c}'`), c);
  assert.throws(() => lerRevisado(raiz, comum.ETAPAS[1][1], 'f'.repeat(64)), /ARQUIVO_DIVERGENTE/);
});

test('estado 1 só lê catálogo e privilégios (nenhuma tabela de dados); a linha SERVICOS fica numa consulta própria, qualificada', () => {
  const sem = comum.SQL_ESTADO.replace(/'[^']*'/g, "''");
  assert.doesNotMatch(sem, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|TRUNCATE)\b/);
  const fontes = [...comum.SQL_ESTADO.matchAll(/\bFROM\s+([a-z_.]+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(fontes)].sort(), ['pg_attribute', 'pg_class', 'pg_constraint', 'pg_proc'], 'só catálogo no estado 1');
  assert.match(comum.SQL_CATEGORIA_103, /FROM public\.adicional_categorias WHERE codigo = 'SERVICOS'/);
  assert.match(comum.SQL_ESTADO, /current_setting\('server_version_num'\)::int AS versao_pg/);
  assert.match(comum.SQL_ESTADO, /has_schema_privilege\(current_user, 'public', 'USAGE'\) AS usar_public/);
  assert.match(comum.SQL_ESTADO, /has_schema_privilege\(current_user, 'public', 'CREATE'\) AS pode_criar/);
  const priv = (t, p) => `has_table_privilege(current_user, oid, '${p}') FROM pg_class WHERE oid = to_regclass('public.${t}')`;
  for (const p of ['SELECT', 'TRIGGER', 'REFERENCES']) assert.ok(comum.SQL_ESTADO.includes(priv('agenda_saloes', p)), 'agenda_saloes ' + p);
  assert.ok(comum.SQL_ESTADO.includes(priv('usuarios_administrativos', 'REFERENCES')));
  for (const t of comum.TABELAS_102) assert.ok(comum.SQL_ESTADO.includes(priv(t, 'SELECT')), t);
  for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'MAINTAIN']) assert.ok(comum.SQL_ESTADO.includes(priv('adicional_categorias', p)), 'adicional_categorias ' + p);
  assert.match(comum.SQL_ESTADO, /WHEN current_setting\('server_version_num'\)::int >= 170000 THEN coalesce\(\(SELECT has_table_privilege\(current_user, oid, 'MAINTAIN'\)/, 'MAINTAIN só a partir do 17');
  assert.match(comum.SQL_ESTADO, /pg_has_role\(current_user, relowner, 'USAGE'\) FROM pg_class WHERE oid = to_regclass\('public\.agenda_saloes'\)/);
  for (const l of ['plpgsql', 'sql']) assert.ok(comum.SQL_ESTADO.includes(`has_language_privilege(current_user, '${l}', 'USAGE')`), l);
});

test('estado e categoria: 102 ausente/completa/parcial; 103 ausente/completa/divergente; ilegível recusa', () => {
  assert.equal(comum.lerEstado(estado()).m102, 'ausente');
  assert.equal(comum.lerEstado(estado(COMPLETA_102)).m102, 'completa');
  for (const p of [{m102_colunas: 13}, {m102_tabelas: 1}, {m102_funcoes: 9}, {...COMPLETA_102, m102_funcoes: 8}, {...COMPLETA_102, m102_colunas: 12}]) {
    assert.equal(comum.lerEstado(estado(p)).m102, 'parcial', JSON.stringify(p));
  }
  assert.equal(comum.lerEstado(estado()).m103, 'nao_lida');
  assert.deepEqual(['AUSENTE', 'IGUAL', 'DIVERGENTE'].map(l => comum.lerCategoria({m103_linha: l})), ['ausente', 'completa', 'divergente']);
  assert.throws(() => comum.lerCategoria({m103_linha: 'TALVEZ'}), /ESTADO_ILEGIVEL m103_linha/);
  assert.throws(() => comum.lerEstado(estado({gatilho_102: 'sim'})), /ESTADO_ILEGIVEL gatilho_102/);
  assert.throws(() => comum.lerEstado(estado({versao_pg: '18'})), /ESTADO_ILEGIVEL versao_pg/);
  assert.throws(() => comum.lerEstado(estado({m102_funcoes: -1})), /ESTADO_ILEGIVEL m102_funcoes/);
});

test('plano: combinações aplicáveis e recusas nomeadas (guardas do catálogo antes da categoria; privilégios um a um)', () => {
  const s = (e, m103 = 'ausente') => ({...comum.lerEstado(estado(e)), m103});
  const p = (e, m103) => comum.planoEtapas(s(e, m103));
  assert.deepEqual(p({}), PLANO_TUDO);
  assert.deepEqual(p(COMPLETA_102), ['integridade 102', 'precheck 103', 'migration 103', 'postcheck 103']);
  assert.deepEqual(p({}, 'completa'), ['precheck 102', 'migration 102', 'postcheck 102', 'integridade 102', 'postcheck 103']);
  assert.deepEqual(p(COMPLETA_102, 'completa'), ['integridade 102', 'postcheck 103']);
  assert.throws(() => p({}, 'nao_lida'), /ESTADO_ILEGIVEL m103/);
  for (const [e, re] of [[{m102_tabelas: 2}, /APLICACAO_PARCIAL_102/], [{com_098: true}, /COM_098_102/], [{versao_pg: 170005}, /VERSAO_PG_NAO_MEDIDA_102 170005/],
    [{versao_pg: 190000}, /VERSAO_PG_NAO_MEDIDA_102 190000/], [{d102: false}, /DEPENDENCIA_AUSENTE_102 093/], [{d103: false}, /DEPENDENCIA_AUSENTE_103 021/],
    [{usar_public: false}, /SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC$/], [{ler_saloes: false}, /SEM_PRIVILEGIO_LEITURA SELECT_AGENDA_SALOES$/],
    [{dono_102: false}, /SEM_PRIVILEGIO_102 DONO$/], [{gatilho_102: false}, /SEM_PRIVILEGIO_102 TRIGGER$/], [{referencias_102: false}, /SEM_PRIVILEGIO_102 REFERENCES$/],
    [{pode_criar: false, linguagens_102: false}, /SEM_PRIVILEGIO_102 CREATE LINGUAGEM$/], [{ler_103: false}, /SEM_PRIVILEGIO_103 SELECT$/],
    [{plpgsql: false}, /SEM_PRIVILEGIO_103 LINGUAGEM$/], [{...COMPLETA_102, ler_102: false}, /SEM_PRIVILEGIO_102 SELECT_CATALOGO$/]]) {
    assert.throws(() => comum.exigirCatalogo(comum.lerEstado(estado(e))), re, JSON.stringify(e));
    assert.throws(() => p(e), re, JSON.stringify(e));
  }
  assert.deepEqual(p({versao_pg: 180000}), PLANO_TUDO); assert.deepEqual(p({versao_pg: 189999}), PLANO_TUDO);
  assert.deepEqual(p({com_098: true, versao_pg: 170005, ...COMPLETA_102}), ['integridade 102', 'precheck 103', 'migration 103', 'postcheck 103'], '098 e versão só com a 102 pendente');
  assert.deepEqual(p({...COMPLETA_102, dono_102: false, pode_criar: false, gatilho_102: false}, 'completa'), ['integridade 102', 'postcheck 103'], 'privilégios da 102 só com ela pendente');
  assert.throws(() => p({}, 'divergente'), /CATEGORIA_DIVERGENTE_103/);
  assert.throws(() => p({inserir_103: false}), /SEM_PRIVILEGIO_103 INSERT$/);
  assert.throws(() => p({inserir_103: false, travar_103: false}), /SEM_PRIVILEGIO_103 INSERT LOCK$/);
  assert.deepEqual(p({inserir_103: false, travar_103: false}, 'completa').at(-1), 'postcheck 103', 'INSERT/LOCK só com a 103 pendente');
});

test('situação do COMMIT: 40003 e classes 08/57/58/XX ou sem SQLSTATE = INDETERMINADO; demais SQLSTATE = desfeita', () => {
  for (const [e, esperado] of [[erroPg('40003'), 'INDETERMINADO'], [erroPg('57014'), 'INDETERMINADO'], [erroPg('08006'), 'INDETERMINADO'], [erroPg('58030'), 'INDETERMINADO'],
    [erroPg('XX000'), 'INDETERMINADO'], [new Error('Connection terminated unexpectedly'), 'INDETERMINADO'], [erroPg('23503'), 'DESFEITA_PELO_SERVIDOR'],
    [erroPg('40001'), 'DESFEITA_PELO_SERVIDOR'], [erroPg('40P01'), 'DESFEITA_PELO_SERVIDOR']]) {
    assert.equal(comum.commitNaFalha(e), esperado, String(e.code ?? e.message));
  }
});

test('trava de alvo de staging e identidade: serviço, ambiente, host, banco, porta, URL sem query; mensagem sem segredos', async () => {
  assert.equal(stg.alvo(ENV_STG).application_name, 'kidmais-migration-102-103-staging');
  for (const [mudanca, erro] of [[{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg'}, /SERVICO_RECUSADO/], [{KIDMAIS_DEPLOY_ENV: 'production'}, /AMBIENTE_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace('dpg-daidko3m8hqs73ce4jt0-a', 'dpg-outro.render.com')}, /HOST_RECUSADO/], [{DATABASE_URL: URL_STG.replace('kidmais_staging_1z91', 'kidmais_manager')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace(':5432', ':5433')}, /PORTA_RECUSADA/], [{DATABASE_URL: URL_STG + '?sslmode=disable'}, /CONNECTION_QUERY_REJECTED/],
    [{DATABASE_SSL: 'talvez'}, /TLS_CONFIGURACAO_RECUSADA/]]) {
    assert.throws(() => stg.alvo({...ENV_STG, ...mudanca}), (e) => erro.test(e.message) && !e.message.includes('SENHA_FALSA'));
  }
  const outro = await stg.conferir({env: ENV_STG, Client: clienteFalso({identidade: {...ID_STG, db: 'outro_banco'}})});
  assert.equal(outro.resultado, 'FALHA'); assert.ok(!JSON.stringify(outro).includes('SENHA_FALSA'));
  assert.equal(stg.DIR, '/opt/render/project/src/data/saloes-102-103-staging');
});

test('conferência: só leitura com lock_timeout e search_path fixo, nada no disco; ausentes = prechecks; completas = integridade/postcheck', async () => {
  const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
  fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
  try {
    const Pronta = clienteFalso();
    const r = await stg.conferir({env: ENV_STG, Client: Pronta});
    assert.equal(r.resultado, 'PRONTA_PARA_APLICAR', JSON.stringify(r));
    assert.deepEqual(r.checks, {'precheck 102': 'PASS', 'precheck 103': 'PASS'});
    assert.deepEqual(r.plano, PLANO_TUDO); assert.deepEqual(r.contagens, CONTAGENS); assert.equal(r.estado.versao_pg, 180006); assert.equal(r.estado.m103, 'ausente');
    assert.deepEqual(escritas(Pronta.log), []);
    const leituras = Pronta.log.filter(x => /^SELECT|^DO|^--/.test(x.sql));
    assert.ok(leituras.length > 0 && leituras.every(x => x.ro), 'toda consulta dentro de READ ONLY');
    const sets = Pronta.log.filter(x => x.sql.startsWith('SET LOCAL'));
    assert.equal(sets.filter(x => x.sql === 'SET LOCAL search_path = public, pg_catalog').length, leituras.length, 'search_path fixo em toda leitura');
    assert.ok(!Pronta.log.some(x => x.sql === C102 || x.sql === C103));
    const Aplicada = clienteFalso({inicial: estado(COMPLETA_102), linha: 'IGUAL'});
    const j = await stg.conferir({env: ENV_STG, Client: Aplicada});
    assert.equal(j.resultado, 'JA_APLICADA_INTEGRIDADE_PASS', JSON.stringify(j));
    assert.deepEqual(j.checks, {'integridade 102': 'PASS', 'postcheck 103': 'PASS'});
    assert.ok(Aplicada.log.some(x => x.ro && x.sql === I102));
    assert.deepEqual(escritas(Aplicada.log), []);
  } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
  assert.deepEqual(gravacoes, [], 'a conferência não grava arquivos');
  // P2-1: guardas do catálogo recusam com código 3 SEM ler a linha SERVICOS (nem contagens, nem checks).
  for (const [e, motivo] of [[{com_098: true}, /COM_098_102/], [{versao_pg: 170005}, /VERSAO_PG_NAO_MEDIDA_102 170005/], [{m102_funcoes: 4}, /APLICACAO_PARCIAL_102/],
    [{d103: false}, /DEPENDENCIA_AUSENTE_103 021/], [{ler_103: false}, /SEM_PRIVILEGIO_103 SELECT/], [{gatilho_102: false}, /SEM_PRIVILEGIO_102 TRIGGER/]]) {
    const C = clienteFalso({inicial: estado(e)});
    const x = await stg.principal(['--conferir-102-103'], ENV_STG, {Client: C});
    assert.equal(x.codigo, 3, JSON.stringify(x)); assert.equal(x.saida.resultado, 'RECUSARIA'); assert.match(x.saida.motivo, motivo);
    assert.ok(!leuCategoria(C), 'linha SERVICOS não lida: ' + JSON.stringify(e));
    assert.ok(!C.log.some(x => x.sql.includes('AS categorias_adicionais') || x.sql === ler('precheck 102')), 'nada lido além do catálogo');
  }
  for (const [opcoes, motivo] of [[{linha: 'DIVERGENTE'}, /CATEGORIA_DIVERGENTE_103/], [{inicial: estado({inserir_103: false})}, /SEM_PRIVILEGIO_103 INSERT/],
    [{inicial: estado(COMPLETA_102), linha: 'IGUAL', integra: false}, /INTEGRIDADE_102 false/], [{falharEm: '103 precheck'}, /falha simulada em 103 precheck/]]) {
    const C = clienteFalso(opcoes);
    const x = await stg.principal(['--conferir-102-103'], ENV_STG, {Client: C});
    assert.equal(x.codigo, 3, JSON.stringify(x)); assert.match(x.saida.motivo, motivo);
  }
  assert.equal((await stg.principal(['--conferir-102-103'], ENV_STG, {Client: clienteFalso()})).codigo, 0);
  await assert.rejects(stg.principal(['--conferir-102-103'], {...ENV_STG, RENDER_SERVICE_ID: 'srv-x'}, {Client: clienteFalso()}), /SERVICO_RECUSADO/);
});

test('aplicação: corpo sem COMMIT → postcheck e integridade NA transação → COMMIT → verificação READ ONLY; 102 antes da 103', async () => {
  await assert.rejects(stg.principal(['--aplicar-102-103-autorizado'], ENV_STG, {Client: clienteFalso()}), /BACKUP_OBRIGATORIO/);
  await assert.rejects(stg.principal(['--aplicar-102-103-autorizado', '--backup', 'x;rm'], ENV_STG, {Client: clienteFalso()}), /BACKUP_INVALIDO/);
  await assert.rejects(stg.principal(['--aplicar-100-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso()}), /ARGUMENTOS_RECUSADOS/);
  const dir = tmp();
  try {
    const C = clienteFalso();
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r));
    assert.deepEqual(r.etapas, PLANO_TUDO); assert.deepEqual(r.commits, {102: 'CONFIRMADO', 103: 'CONFIRMADO'}); assert.deepEqual(r.commitadas, ['102', '103']);
    assert.equal(r.estadoDepois.m102, 'completa'); assert.equal(r.estadoDepois.m103, 'completa');
    assert.deepEqual(escritas(C.log).map(x => x.sql), [C102, C103], 'só os corpos (sem COMMIT) escrevem, na ordem');
    for (const [corpo, verifs] of [[C102, ['postcheck 102', 'integridade 102']], [C103, ['postcheck 103']]]) {
      const i = C.log.findIndex(x => x.sql === corpo), iCommit = C.log.findIndex((x, k) => k > i && x.sql === 'COMMIT');
      for (const v of verifs) {
        const k = C.log.findIndex((x, n) => n > i && x.sql === ler(v));
        assert.ok(k > i && k < iCommit && C.log[k].emTransacao && !C.log[k].ro, v + ' dentro da transação, antes do COMMIT');
        assert.ok(C.log.slice(iCommit).some(x => x.ro && x.sql === ler(v)), v + ' de novo em READ ONLY depois do COMMIT');
      }
    }
    const m = JSON.parse(fs.readFileSync(r.marcador, 'utf8'));
    assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.backup, BACKUP); assert.deepEqual(m.commits, {102: 'CONFIRMADO', 103: 'CONFIRMADO'});
    assert.deepEqual(m.etapas.find(e => e.nome === 'migration 102').antesDoCommit, {'postcheck 102': 'PASS', 'integridade 102': 'PASS'});
    assert.ok(!fs.readFileSync(r.marcador, 'utf8').includes('SENHA_FALSA'));
    await assert.rejects(stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: clienteFalso(), disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('aplicação parcial do plano: só a 102 (103 já igual) ou só a 103 (102 completa e íntegra)', async () => {
  for (const [opcoes, etapas, corpos] of [[{linha: 'IGUAL'}, ['precheck 102', 'migration 102', 'postcheck 102', 'integridade 102', 'postcheck 103'], [C102]],
    [{inicial: estado(COMPLETA_102)}, ['integridade 102', 'precheck 103', 'migration 103', 'postcheck 103'], [C103]]]) {
    const dir = tmp();
    try {
      const C = clienteFalso(opcoes);
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS'); assert.deepEqual(r.etapas, etapas);
      assert.deepEqual(escritas(C.log).map(x => x.sql), corpos);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('P2-4: retrato divergente DENTRO da transação (integra_102 false antes do COMMIT): ROLLBACK, nada confirmado, 103 não roda', async () => {
  const dir = tmp();
  try {
    const C = clienteFalso({integraNaTransacao: false});
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /INTEGRIDADE_102 false/);
    assert.deepEqual(r.commits, {102: 'NAO_COMMITADA'}); assert.deepEqual(r.commitadas, []);
    const i = C.log.findIndex(x => x.sql === C102);
    assert.ok(!C.log.slice(i).some(x => x.sql === 'COMMIT'), 'COMMIT nunca enviado');
    assert.ok(C.log.slice(i).some(x => x.sql === 'ROLLBACK'), 'ROLLBACK enviado');
    assert.equal(comum.lerEstado(C.atual).m102, 'ausente', 'nada confirmado'); assert.ok(!C.log.some(x => x.sql === C103));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('situação por migration: falha no corpo = NAO_COMMITADA; no COMMIT = 40003/08/sem resposta INDETERMINADO, recusa desfeita; 103 com a 102 confirmada', async () => {
  const casos = [
    ['corpo 102 (lock)', {falharEm: 'CREATE TABLE public.agenda_salao_itens_catalogo', erro: erroPg('55P03')}, {102: 'NAO_COMMITADA'}],
    ['corpo 102 (conexão caiu)', {falharEm: 'CREATE TABLE public.agenda_salao_itens_catalogo', erro: new Error('Connection terminated unexpectedly')}, {102: 'NAO_COMMITADA'}],
    ['postcheck 102 na transação', {falharEm: '102 postcheck: colunas', erro: erroPg('P0001')}, {102: 'NAO_COMMITADA'}],
    ['COMMIT 102 40003', {falharCommit: {n: 1, erro: erroPg('40003')}}, {102: 'INDETERMINADO'}],
    ['COMMIT 102 08006', {falharCommit: {n: 1, erro: erroPg('08006')}}, {102: 'INDETERMINADO'}],
    ['COMMIT 102 sem resposta', {falharCommit: {n: 1, erro: new Error('Connection terminated unexpectedly')}}, {102: 'INDETERMINADO'}],
    ['COMMIT 102 recusado (23503)', {falharCommit: {n: 1, erro: erroPg('23503')}}, {102: 'DESFEITA_PELO_SERVIDOR'}],
    ['COMMIT 102 respondido como ROLLBACK', {falharCommit: {n: 1, rollback: true}}, {102: 'DESFEITA_PELO_SERVIDOR'}],
    ['corpo 103 (permissão)', {falharEm: 'INSERT INTO public.adicional_categorias', erro: erroPg('42501')}, {102: 'CONFIRMADO', 103: 'NAO_COMMITADA'}],
    ['COMMIT 103 40003', {falharCommit: {n: 2, erro: erroPg('40003')}}, {102: 'CONFIRMADO', 103: 'INDETERMINADO'}],
    ['COMMIT 103 recusado', {falharCommit: {n: 2, erro: erroPg('23505')}}, {102: 'CONFIRMADO', 103: 'DESFEITA_PELO_SERVIDOR'}],
  ];
  for (const [rotulo, opcoes, commits] of casos) {
    const dir = tmp();
    try {
      const C = clienteFalso(opcoes);
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'FALHA', rotulo + JSON.stringify(r)); assert.deepEqual(r.commits, commits, rotulo);
      assert.match(r.reconciliar, /--conferir-102-103/);
      const m = JSON.parse(fs.readFileSync(r.marcador, 'utf8'));
      assert.equal(m.situacao, 'FALHA'); assert.deepEqual(m.commits, commits, rotulo + ' (marcador)');
      if (!('103' in commits)) assert.ok(!C.log.some(x => x.sql === C103), rotulo + ': 103 não roda');
      await assert.rejects(stg.principal(['--aplicar-102-103-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso(), dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('retomada autorizada: 103 falhou com a 102 confirmada; marcador renomeado → nova execução confere a 102 e aplica só a 103', async () => {
  const dir = tmp();
  try {
    const C1 = clienteFalso({falharEm: 'INSERT INTO public.adicional_categorias', erro: erroPg('55P03')});
    const r1 = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C1, disco: semDisco});
    assert.deepEqual(r1.commits, {102: 'CONFIRMADO', 103: 'NAO_COMMITADA'});
    fs.renameSync(path.join(dir, comum.MARCADOR), path.join(dir, 'migration-102-103.2026-10-27T13-00.json'));
    const C2 = clienteFalso({inicial: {...C1.atual}});
    const r2 = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C2, disco: semDisco});
    assert.equal(r2.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r2));
    assert.deepEqual(r2.etapas, ['integridade 102', 'precheck 103', 'migration 103', 'postcheck 103']); assert.deepEqual(r2.commits, {103: 'CONFIRMADO'});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8')).tentativasAnteriores, ['migration-102-103.2026-10-27T13-00.json']);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('estado que não completa depois do COMMIT e mudança entre conferência e aplicação: recusa sem seguir adiante', async () => {
  for (const [opcoes, motivo, commits] of [[{naoCompleta: '102'}, /ESTADO_DEPOIS_102/, {102: 'CONFIRMADO'}], [{naoCompleta: '103'}, /ESTADO_DEPOIS_103/, {102: 'CONFIRMADO', 103: 'CONFIRMADO'}],
    [{integra: false}, /INTEGRIDADE_102 false/, {102: 'CONFIRMADO'}], [{inicial: estado({com_098: true})}, /COM_098_102/, {}]]) {
    const dir = tmp();
    try {
      const C = clienteFalso(opcoes);
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, motivo); assert.deepEqual(r.commits, commits);
      if (opcoes.integra === false) assert.ok(!C.log.some(x => x.sql === C103), 'integridade da 102 falsa depois do COMMIT: a 103 não roda');
      if (opcoes.inicial) assert.deepEqual(escritas(C.log), []);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('já aplicadas: só integridade e postcheck, nenhuma escrita; disco ausente recusa antes de conectar; códigos', async () => {
  const dir = tmp();
  try {
    const C = clienteFalso({inicial: estado(COMPLETA_102), linha: 'IGUAL'});
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'JA_APLICADA_INTEGRIDADE_PASS'); assert.deepEqual(r.etapas, ['integridade 102', 'postcheck 103']);
    assert.deepEqual(escritas(C.log), []); assert.deepEqual(r.commits, {});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  await assert.rejects(stg.executar({env: ENV_STG, backup: BACKUP, dir: tmp(), Client: clienteFalso(), disco: () => assert.fail('DISCO_PERSISTENTE_AUSENTE')}), /DISCO_PERSISTENTE_AUSENTE/);
  const dir2 = tmp();
  try {
    const x = await stg.principal(['--aplicar-102-103-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso({falharEm: 'CREATE TABLE public.agenda_salao_fotos'}), dir: dir2, disco: semDisco});
    assert.equal(x.codigo, 2); assert.equal(x.saida.resultado, 'FALHA');
  } finally { fs.rmSync(dir2, {recursive: true, force: true}); }
});

test('plano sem conexão: 7 arquivos com sha, retrato com prova no alvo, ordem e paradas (incl. marcador ilegível e INDETERMINADO); nunca os down', async () => {
  const {codigo, saida} = await stg.principal([], {});
  assert.equal(codigo, 0); assert.equal(saida.conecta, false); assert.equal(saida.ambiente, 'staging');
  assert.deepEqual(saida.arquivos.map(a => a.sha256), comum.ETAPAS.map(e => e[2]));
  assert.equal(saida.retrato102.sha256, comum.RETRATO_102); assert.equal(saida.retrato102.versaoMaiorMedida, 18); assert.match(saida.retrato102.provaNoAlvo, /antes do COMMIT/);
  assert.match(saida.ordem[0], /deploy do código/);
  assert.ok(saida.ordem.some(o => /janela combinada/.test(o) && /ACCESS EXCLUSIVE em agenda_saloes/.test(o)) && saida.ordem.some(o => /imediatamente antes/.test(o)) && saida.ordem.some(o => /ponto de recuperação PITR/.test(o)));
  assert.ok(saida.preRequisitos.some(p => /bloqueia a 098/.test(p) && /D1/.test(p)) && saida.preRequisitos.some(p => /versão maior 18/.test(p)) && saida.preRequisitos.some(p => /TRIGGER/.test(p) && /USAGE e CREATE em public/.test(p)));
  assert.ok(saida.paradas.some(p => /nunca apagar/.test(p)) && saida.paradas.some(p => /NAO_COMMITADA/.test(p) && /INDETERMINADO/.test(p))
    && saida.paradas.some(p => /falha na 103 com a 102 confirmada/.test(p)) && saida.paradas.some(p => /marcador incompleto ou ilegível/.test(p) && /processo interrompido/.test(p)));
  assert.ok(saida.recuperacao.some(r => /nunca presumir/.test(r)));
  // Parecer do Astra (27/10, rodada 2): recuperação desta janela = PITR; restauração lógica exige referência revisada.
  assert.ok(saida.ordem.some(o => /PITR/.test(o) && /export lógico NÃO serve/.test(o)), 'ordem exige PITR');
  assert.ok(!saida.ordem.some(o => /export funcional/.test(o)));
  assert.ok(saida.recuperacao.some(r => /restauração PITR/.test(r)) && saida.recuperacao.some(r => /LÓGICA/.test(r) && /nunca aceitar o hash encontrado/.test(r)));
  assert.ok(saida.nuncaExecuta.includes('down 102') && saida.nuncaExecuta.includes('down 103'));
  assert.ok(!saida.arquivos.some(a => a.arquivo.includes('rollback')));
});
