/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 109 (renovação substituta, staging) com cliente simulado que só CONFIRMA no COMMIT e descarta no ROLLBACK:
// hashes (SQL e contrato), estado pelo catálogo + capacidade do contrato do cron (retrato 075/109/divergente), privilégios um
// a um, sessões da renovação ativas, trava de alvo, conferência só leitura com search_path fixo, migration sem o COMMIT
// final com postcheck e capacidade '109' na transação, situação do COMMIT (NAO_COMMITADA / CONFIRMADO /
// DESFEITA_PELO_SERVIDOR / INDETERMINADO, inclusive 40003), contagens por estado inalteradas, marcador anti-repetição e
// retomada pelo marcador renomeado. Sem rede nem banco (a prova real é lib/assinatura/aplicador-109.postgres.test.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {createHash} = require('node:crypto');
const comum = require('./migration-109-comum.cjs');
const {lerRevisado} = require('./migration-092-094-comum.cjs');
const stg = require('./migration-109-staging.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_STG = 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91';
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false', DATABASE_URL: URL_STG});
const ID_STG = {db: 'kidmais_staging_1z91', tls: false, servidor_privado: true};
const BACKUP = 'PITR 2026-10-30T09:00Z staging';
const ler = nome => { const [, a, h] = comum.ETAPAS.find(e => e[0] === nome); return lerRevisado(raiz, a, h); };
const M109 = ler('migration 109'), POS109 = ler('postcheck 109'), PRE109 = ler('precheck 109');
const C109 = comum.semCommitFinal(M109, 'm109');
const CORPO_PRE = comum.corpoSomenteLeitura(PRE109, 'pre'), CORPO_POS = comum.corpoSomenteLeitura(POS109, 'pos');
const erroPg = (code, msg = 'erro simulado') => Object.assign(new Error(msg), {code});
const estado = (extra = {}) => ({versao_pg: 180006, tabela: true, dono: true, ler_renovacoes: true, usar_public: true, pode_criar: true, plpgsql: true,
  sessoes_renovacao: 0, papel_trocado: true, ...extra});
const POR_ESTADO = [{estado: 'CANCELADA', n: 5}, {estado: 'PENDENTE', n: 1}, {estado: 'REGULAR', n: 1}];
const PLANO_TUDO = ['precheck 109', 'migration 109', 'capacidade 109'];
let R = null, SCHEMA = null;
test.before(async () => {
  R = await import(pathToFileURL(path.join(raiz, 'lib/assinatura/renovacao-schema-retratos.ts')).href);
  SCHEMA = await import(pathToFileURL(path.join(raiz, 'lib/assinatura/renovacao-schema.ts')).href);
});
/** Retrato com uma deriva (corpo de função trocado), para o caso divergente. */
const derivado = r => ({...r, funcoes: r.funcoes.map((f, i) => i === 0 ? {...f, sha256: '0'.repeat(64)} : f)});

/**
 * Cliente simulado transacional: o corpo da migration (sem COMMIT) deixa o retrato 109 PENDENTE; 'COMMIT' confirma e
 * 'ROLLBACK' descarta. SQL_ESTADO devolve o estado CONFIRMADO; SQL_RETRATO devolve o retrato visível (pendente na
 * transação). Opções: retrato (inicial: '075' | '109' | objeto), falharEm (trecho que lança `erro`), falharCommit
 * ({n, erro} ou {n, rollback: true}), retratoNaTransacao (o que a migration deixa), naoCompleta, contagensDepois.
 */
function clienteFalso({inicial = estado(), retrato = '075', identidade = ID_STG, falharEm, erro, falharCommit, retratoNaTransacao, naoCompleta, porEstadoDepois, retratoDepoisDe, falharNaTransacao} = {}) {
  const log = []; let ro = false, pendente = null, commits = 0, leiturasRetrato = 0;
  const atual = {...inicial, retrato: typeof retrato === 'string' ? (retrato === '109' ? R.RETRATO_109 : R.RETRATO_075) : retrato, porEstado: POR_ESTADO, aplicada: retrato === '109'};
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql, params) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') ro = true;
      log.push({sql, ro, emTransacao: pendente !== null});
      if (falharEm && sql.includes(falharEm)) { if (pendente) pendente.abortada = true; throw erro ?? erroPg('55P03', 'falha simulada em ' + falharEm); }
      if (falharNaTransacao && pendente && sql.includes(falharNaTransacao)) { pendente.abortada = true; throw erro ?? erroPg('57014'); }
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
      if (sql === comum.SQL_ESTADO) return {rows: [{...atual, retrato: undefined, porEstado: undefined, aplicada: undefined}]};
      if (sql === "SELECT current_setting('search_path') AS v") return {rows: [{v: 'public, pg_catalog'}]};
      if (sql.startsWith("SELECT set_config('search_path'")) { if (params) assert.equal(params[0], 'public, pg_catalog'); return {rows: []}; }
      if (sql === SCHEMA.SQL_RETRATO) {
        // DDL concorrente simulada: depois de N leituras do retrato, o confirmado passa a ser outro.
        if (retratoDepoisDe && ++leiturasRetrato > retratoDepoisDe.n) atual.retrato = retratoDepoisDe.retrato;
        return {rows: [{retrato: pendente ? pendente.retrato : atual.retrato}]};
      }
      if (sql.startsWith('SELECT estado, count(*)')) return {rows: [...(pendente || !atual.aplicada || !porEstadoDepois ? atual.porEstado : porEstadoDepois)]};
      if (sql.includes('substitui_id IS NOT NULL')) return {rows: [{n: 0}]};
      if (sql === C109) {
        assert.equal(ro, false, 'migration nunca em READ ONLY');
        const r109 = retratoNaTransacao ?? R.RETRATO_109;
        pendente = {retrato: r109, aplicar: () => { if (!naoCompleta) { atual.retrato = r109; atual.aplicada = true; } }};
      }
      assert.notEqual(sql, M109, 'o arquivo COM o COMMIT final nunca é enviado');
      assert.ok(sql !== PRE109 && sql !== POS109, 'precheck/postcheck vão sem a própria moldura');
      return {rows: []};
    }
  };
  C.log = log; C.atual = atual;
  return C;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-109-'));
const semDisco = () => {};
// Configuração de sessão (prazo de execução) não é escrita de dados.
const LEITURA = /^(BEGIN TRANSACTION READ ONLY|ROLLBACK|COMMIT|SET LOCAL|SELECT |SET statement_timeout = |RESET statement_timeout$)/;
const escritas = log => log.filter(x => !x.ro && !LEITURA.test(x.sql) && !x.emTransacao);

test('hashes dos 3 SQL e do contrato; migration é UMA transação enviada sem o COMMIT final; pre/postcheck só o corpo', () => {
  for (const [, arquivo, hash] of comum.ETAPAS) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), hash, arquivo);
  for (const [arquivo, hash] of comum.CONTRATO) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), hash, arquivo);
  assert.deepEqual(comum.ETAPAS.map(e => e[0]), ['precheck 109', 'migration 109', 'postcheck 109']);
  assert.match(M109, /SET LOCAL lock_timeout = '5s'/); assert.match(M109, /LOCK TABLE public\.assinatura_renovacoes IN ACCESS EXCLUSIVE MODE;/);
  assert.equal(C109 + 'COMMIT;\n', M109, 'só o COMMIT final sai'); assert.doesNotMatch(C109, /^COMMIT;$/m);
  assert.throws(() => comum.semCommitFinal(M109 + 'COMMIT;\n', 'x'), /TRANSACAO_INESPERADA/);
  assert.throws(() => comum.semCommitFinal(M109.replace('BEGIN;\n', ''), 'x'), /TRANSACAO_INESPERADA/);
  // O postcheck enviado na transação é o CORPO do arquivo gerado do contrato (sem BEGIN READ ONLY nem ROLLBACK).
  for (const corpo of [CORPO_PRE, CORPO_POS]) { assert.match(corpo, /^DO \$\$/); assert.doesNotMatch(corpo, /^(BEGIN TRANSACTION|ROLLBACK;|COMMIT;)/m); assert.match(corpo, /END \$\$;\n$/); }
  assert.equal(POS109, SCHEMA.postcheck109(), 'postcheck = gerado do contrato');
  assert.throws(() => comum.corpoSomenteLeitura(POS109.replace('ROLLBACK;\n', 'COMMIT;\n'), 'x'), /MOLDURA_INESPERADA/);
  assert.throws(() => comum.corpoSomenteLeitura('BEGIN;\n' + POS109, 'x'), /MOLDURA_INESPERADA/);
  assert.throws(() => comum.corpoSomenteLeitura(POS109.replace('BEGIN TRANSACTION READ ONLY;\n', ''), 'x'), /MOLDURA_INESPERADA/);
  assert.throws(() => lerRevisado(raiz, comum.ETAPAS[1][1], 'f'.repeat(64)), /ARQUIVO_DIVERGENTE/);
});

test('estado só lê catálogo, privilégios e pg_stat_activity (nenhuma tabela de dados); privilégios um a um', () => {
  const sem = comum.SQL_ESTADO.replace(/'[^']*'/g, "''");
  assert.doesNotMatch(sem, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|TRUNCATE)\b/);
  const fontes = [...comum.SQL_ESTADO.matchAll(/\bFROM\s+([a-z_.]+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(fontes)].sort(), ['pg_class', 'pg_stat_activity'], 'só catálogo');
  assert.match(comum.SQL_ESTADO, /pg_has_role\(current_user, relowner, 'USAGE'\) FROM pg_class WHERE oid = to_regclass\('public\.assinatura_renovacoes'\)\), false\) AS dono/);
  assert.match(comum.SQL_ESTADO, /has_schema_privilege\(current_user, 'public', 'CREATE'\) AS pode_criar/);
  assert.match(comum.SQL_ESTADO, /has_language_privilege\(current_user, 'plpgsql', 'USAGE'\)/);
  assert.match(comum.SQL_ESTADO, /application_name LIKE 'kidmais-renovacao%'/);
  assert.match(comum.SQL_ESTADO, /pid <> pg_backend_pid\(\)/);
  // O cron, a renovação manual/restrita e o preflight usam o prefixo (scripts/assinatura-renova*.cjs).
  for (const [arquivo, nome] of [['scripts/assinatura-renovacao-cron.cjs', 'kidmais-renovacao-cron'], ['scripts/assinatura-renovar.cjs', 'kidmais-renovacao-fundador'],
    ['scripts/assinatura-renovar-restrito.cjs', 'kidmais-renovacao-restrita'], ['scripts/assinatura-renovacao-preflight.cjs', 'kidmais-renovacao-preflight']]) {
    assert.ok(fs.readFileSync(path.join(raiz, arquivo), 'utf8').includes(`application_name: '${nome}'`), arquivo);
    assert.ok(nome.startsWith(comum.PREFIXO_RENOVACAO), nome);
  }
});

test('estado e plano: 075 = pendente, 109 = completa, divergente recusa com nomes; privilégios e sessões só no caso pendente', () => {
  const cap = c => c === 'X' ? {capacidade: 'INCOMPATIVEL', divergencias: ['funcoes:kidmais_075_renovacao_guarda:DIVERGE']} : {capacidade: c};
  assert.equal(comum.lerEstado(estado(), cap('075')).m109, 'ausente');
  assert.equal(comum.lerEstado(estado(), cap('109')).m109, 'completa');
  assert.equal(comum.lerEstado(estado(), cap('X')).m109, 'divergente');
  assert.throws(() => comum.lerEstado(estado({dono: 'sim'}), cap('075')), /ESTADO_ILEGIVEL dono/);
  assert.throws(() => comum.lerEstado(estado({sessoes_renovacao: -1}), cap('075')), /ESTADO_ILEGIVEL sessoes_renovacao/);
  assert.throws(() => comum.lerEstado(estado(), {capacidade: 'outra'}), /ESTADO_ILEGIVEL capacidade/);
  const p = (e, c = '075') => comum.planoEtapas(comum.lerEstado(estado(e), cap(c)));
  assert.deepEqual(p({}), PLANO_TUDO);
  assert.deepEqual(p({}, '109'), ['capacidade 109']);
  for (const [e, c, re] of [[{}, 'X', /RETRATO_DIVERGENTE_109 funcoes:kidmais_075_renovacao_guarda:DIVERGE$/], [{tabela: false}, '075', /TABELA_AUSENTE/],
    [{usar_public: false}, '075', /SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC$/], [{ler_renovacoes: false}, '109', /SEM_PRIVILEGIO_LEITURA SELECT_RENOVACOES$/],
    [{dono: false}, '075', /SEM_PRIVILEGIO_109 DONO_RENOVACOES$/], [{pode_criar: false}, '075', /SEM_PRIVILEGIO_109 CREATE$/],
    [{plpgsql: false, dono: false}, '075', /SEM_PRIVILEGIO_109 DONO_RENOVACOES LINGUAGEM$/], [{sessoes_renovacao: 1}, '075', /RENOVACAO_EM_EXECUCAO 1$/]]) {
    assert.throws(() => p(e, c), re, JSON.stringify(e) + c);
  }
  assert.deepEqual(p({dono: false, pode_criar: false, plpgsql: false, sessoes_renovacao: 2}, '109'), ['capacidade 109'], 'dono/CREATE/sessões só com a 109 pendente');
});

test('situação do COMMIT: 40003 e classes 08/57/58/XX ou sem SQLSTATE = INDETERMINADO; demais SQLSTATE = desfeita', () => {
  for (const [e, esperado] of [[erroPg('40003'), 'INDETERMINADO'], [erroPg('57014'), 'INDETERMINADO'], [erroPg('08006'), 'INDETERMINADO'], [erroPg('XX000'), 'INDETERMINADO'],
    [new Error('Connection terminated unexpectedly'), 'INDETERMINADO'], [erroPg('23505'), 'DESFEITA_PELO_SERVIDOR'], [erroPg('P0001'), 'DESFEITA_PELO_SERVIDOR']]) {
    assert.equal(comum.commitNaFalha(e), esperado, String(e.code ?? e.message));
  }
});

test('trava de alvo de staging e identidade: serviço, ambiente, host, banco, porta, URL sem query; mensagem sem segredos', async () => {
  assert.equal(stg.alvo(ENV_STG).application_name, 'kidmais-migration-109-staging');
  assert.ok(!stg.alvo(ENV_STG).application_name.startsWith(comum.PREFIXO_RENOVACAO), 'o próprio aplicador não conta como sessão da renovação');
  for (const [mudanca, erro] of [[{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg'}, /SERVICO_RECUSADO/], [{KIDMAIS_DEPLOY_ENV: 'production'}, /AMBIENTE_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace('dpg-daidko3m8hqs73ce4jt0-a', 'dpg-outro.render.com')}, /HOST_RECUSADO/], [{DATABASE_URL: URL_STG.replace('kidmais_staging_1z91', 'kidmais_manager')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace(':5432', ':5433')}, /PORTA_RECUSADA/], [{DATABASE_URL: URL_STG + '?sslmode=disable'}, /CONNECTION_QUERY_REJECTED/],
    [{DATABASE_SSL: 'talvez'}, /TLS_CONFIGURACAO_RECUSADA/]]) {
    assert.throws(() => stg.alvo({...ENV_STG, ...mudanca}), (e) => erro.test(e.message) && !e.message.includes('SENHA_FALSA'));
  }
  const outro = await stg.conferir({env: ENV_STG, Client: clienteFalso({identidade: {...ID_STG, db: 'outro_banco'}})});
  assert.equal(outro.resultado, 'FALHA'); assert.ok(!JSON.stringify(outro).includes('SENHA_FALSA'));
  assert.equal(stg.DIR, '/opt/render/project/src/data/renovacao-109-staging');
});

test('conferência: só leitura com lock_timeout e search_path fixo, nada no disco; 075 = precheck; 109 = capacidade; contagens', async () => {
  const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
  fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
  try {
    const Pronta = clienteFalso();
    const r = await stg.conferir({env: ENV_STG, Client: Pronta});
    assert.equal(r.resultado, 'PRONTA_PARA_APLICAR', JSON.stringify(r));
    assert.deepEqual(r.checks, {'precheck 109': 'PASS'}); assert.deepEqual(r.plano, PLANO_TUDO);
    assert.equal(r.estado.capacidade, '075'); assert.deepEqual(r.contagens, {total: 7, porEstado: {CANCELADA: 5, PENDENTE: 1, REGULAR: 1}});
    assert.deepEqual(escritas(Pronta.log), []);
    const leituras = Pronta.log.filter(x => /^SELECT|^DO|^WITH/.test(x.sql));
    assert.ok(leituras.length > 0 && leituras.every(x => x.ro), 'toda consulta dentro de READ ONLY');
    assert.ok(Pronta.log.some(x => x.ro && x.sql === CORPO_PRE)); assert.ok(!Pronta.log.some(x => x.sql === C109));
    const Aplicada = clienteFalso({retrato: '109'});
    const j = await stg.conferir({env: ENV_STG, Client: Aplicada});
    assert.equal(j.resultado, 'JA_APLICADA_CAPACIDADE_PASS', JSON.stringify(j));
    assert.deepEqual(j.checks, {'capacidade 109': 'PASS'}); assert.equal(j.contagens.comSubstituto, 0);
    assert.ok(!Aplicada.log.some(x => x.sql === CORPO_PRE || x.sql === CORPO_POS), 'nem precheck nem postcheck numa 109 já aplicada');
    assert.deepEqual(escritas(Aplicada.log), []);
  } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
  assert.deepEqual(gravacoes, [], 'a conferência não grava arquivos');
  const div = () => derivado(R.RETRATO_075);
  for (const [opcoes, motivo] of [[{retrato: 'D'}, /RETRATO_DIVERGENTE_109 funcoes:/], [{inicial: estado({dono: false})}, /SEM_PRIVILEGIO_109 DONO_RENOVACOES/],
    [{inicial: estado({sessoes_renovacao: 1})}, /RENOVACAO_EM_EXECUCAO 1/], [{falharEm: '109 precheck', erro: erroPg('P0001', '109 precheck: x')}, /109 precheck: x/]]) {
    const C = clienteFalso({...opcoes, retrato: opcoes.retrato === 'D' ? div() : opcoes.retrato});
    if (opcoes.falharEm) { // o precheck falha pelo conteúdo, não pela moldura: simula pela primeira linha do corpo
      C.prototype.query = (q => async function (sql, p) { if (sql === CORPO_PRE) { throw erroPg('P0001', '109 precheck: x'); } return q.call(this, sql, p); })(C.prototype.query);
    }
    const x = await stg.principal(['--conferir-109'], ENV_STG, {Client: C});
    assert.equal(x.codigo, 3, JSON.stringify(x)); assert.equal(x.saida.resultado, 'RECUSARIA'); assert.match(x.saida.motivo, motivo);
    if (!opcoes.falharEm) assert.ok(!C.log.some(x => x.sql === CORPO_PRE || x.sql.startsWith('SELECT estado, count(*)')), 'nada lido além do catálogo');
  }
  assert.equal((await stg.principal(['--conferir-109'], ENV_STG, {Client: clienteFalso()})).codigo, 0);
  await assert.rejects(stg.principal(['--conferir-109'], {...ENV_STG, RENDER_SERVICE_ID: 'srv-x'}, {Client: clienteFalso()}), /SERVICO_RECUSADO/);
});

test('aplicação: corpo sem COMMIT → postcheck e capacidade NA transação → COMMIT → capacidade READ ONLY; contagens; marcador', async () => {
  await assert.rejects(stg.principal(['--aplicar-109-autorizado'], ENV_STG, {Client: clienteFalso()}), /BACKUP_OBRIGATORIO/);
  await assert.rejects(stg.principal(['--aplicar-109-autorizado', '--backup', 'x;rm'], ENV_STG, {Client: clienteFalso()}), /BACKUP_INVALIDO/);
  await assert.rejects(stg.principal(['--aplicar-105-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso()}), /ARGUMENTOS_RECUSADOS/);
  const dir = tmp();
  try {
    const C = clienteFalso();
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r));
    assert.deepEqual(r.etapas, PLANO_TUDO); assert.deepEqual(r.commits, {109: 'CONFIRMADO'}); assert.deepEqual(r.commitadas, ['109']);
    assert.equal(r.estadoDepois.m109, 'completa'); assert.equal(r.estadoDepois.capacidade, '109');
    assert.deepEqual(r.contagensDepois.porEstado, r.contagensAntes.porEstado); assert.equal(r.contagensDepois.comSubstituto, 0);
    assert.deepEqual(escritas(C.log).map(x => x.sql), [C109], 'só o corpo (sem COMMIT) escreve');
    const i = C.log.findIndex(x => x.sql === C109), iCommit = C.log.findIndex((x, k) => k > i && x.sql === 'COMMIT');
    for (const v of [CORPO_POS, SCHEMA.SQL_RETRATO]) {
      const k = C.log.findIndex((x, n) => n > i && x.sql === v);
      assert.ok(k > i && k < iCommit && C.log[k].emTransacao && !C.log[k].ro, 'verificação dentro da transação, antes do COMMIT: ' + v.slice(0, 20));
    }
    assert.ok(C.log.slice(0, i).some(x => x.ro && x.sql === CORPO_PRE), 'precheck em READ ONLY antes');
    assert.ok(C.log.slice(iCommit).some(x => x.ro && x.sql === SCHEMA.SQL_RETRATO), 'capacidade de novo em READ ONLY depois do COMMIT');
    assert.ok(!C.log.slice(iCommit).some(x => x.sql === CORPO_POS), 'postcheck só dentro da transação');
    // P3-1: prazo de execução de sessão logo antes do corpo (fora de transação e de READ ONLY), desfeito depois do COMMIT.
    assert.deepEqual(C.log[i - 1], {sql: "SET statement_timeout = '60s'", ro: false, emTransacao: false}, 'prazo imediatamente antes do corpo');
    assert.equal(C.log.filter(x => /statement_timeout = /.test(x.sql) && !x.sql.startsWith('SET LOCAL')).length, 1);
    assert.ok(C.log.slice(iCommit).some(x => x.sql === 'RESET statement_timeout'), 'prazo de sessão desfeito depois');
    const m = JSON.parse(fs.readFileSync(r.marcador, 'utf8'));
    assert.equal(m.etapas.find(e => e.nome === 'migration 109').orcamento, '60s');
    assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.backup, BACKUP); assert.deepEqual(m.commits, {109: 'CONFIRMADO'});
    assert.deepEqual(m.etapas.find(e => e.nome === 'migration 109').antesDoCommit, {'postcheck 109': 'PASS', 'capacidade 109': 'PASS'});
    assert.ok(!fs.readFileSync(r.marcador, 'utf8').includes('SENHA_FALSA'));
    await assert.rejects(stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: clienteFalso(), disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('capacidade divergente DENTRO da transação (retrato que a migration deixou ≠ 109): ROLLBACK, nada confirmado', async () => {
  const dir = tmp();
  try {
    const C = clienteFalso({retratoNaTransacao: derivado(R.RETRATO_109)});
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /CAPACIDADE_109 INCOMPATIVEL funcoes:/);
    assert.deepEqual(r.commits, {109: 'NAO_COMMITADA'}); assert.deepEqual(r.commitadas, []);
    const i = C.log.findIndex(x => x.sql === C109);
    assert.ok(!C.log.slice(i).some(x => x.sql === 'COMMIT'), 'COMMIT nunca enviado'); assert.ok(C.log.slice(i).some(x => x.sql === 'ROLLBACK'));
    assert.equal(C.atual.retrato, R.RETRATO_075, 'nada confirmado');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('situação do COMMIT na aplicação: corpo/verificação = NAO_COMMITADA; COMMIT 40003/08/sem resposta = INDETERMINADO; recusa = desfeita', async () => {
  const casos = [
    ['corpo (lock)', {falharEm: 'LOCK TABLE public.assinatura_renovacoes', erro: erroPg('55P03')}, 'NAO_COMMITADA'],
    ['corpo (conexão caiu)', {falharEm: 'ALTER TABLE public.assinatura_renovacoes ADD COLUMN', erro: new Error('Connection terminated unexpectedly')}, 'NAO_COMMITADA'],
    ['postcheck na transação', {falharEm: 'diverge do aprovado', erro: erroPg('P0001')}, 'NAO_COMMITADA'],
    ['COMMIT 40003', {falharCommit: {n: 1, erro: erroPg('40003')}}, 'INDETERMINADO'],
    ['COMMIT 08006', {falharCommit: {n: 1, erro: erroPg('08006')}}, 'INDETERMINADO'],
    ['prazo estourado no corpo (57014)', {falharEm: 'CREATE UNIQUE INDEX assinatura_renovacoes_109_vigente_uq', erro: erroPg('57014', 'canceling statement due to statement timeout')}, 'NAO_COMMITADA'],
    ['prazo estourado na capacidade (57014)', {falharNaTransacao: 'WITH t AS (SELECT to_regclass', erro: erroPg('57014', 'canceling statement due to statement timeout')}, 'NAO_COMMITADA'],
    ['prazo estourado no COMMIT (57014)', {falharCommit: {n: 1, erro: erroPg('57014')}}, 'INDETERMINADO'],
    ['prazo de sessão recusado (antes do corpo)', {falharEm: "SET statement_timeout = '60s'", erro: erroPg('42501')}, 'NAO_COMMITADA'],
    ['COMMIT sem resposta', {falharCommit: {n: 1, erro: new Error('Connection terminated unexpectedly')}}, 'INDETERMINADO'],
    ['COMMIT recusado (P0001 do gatilho diferido)', {falharCommit: {n: 1, erro: erroPg('P0001')}}, 'DESFEITA_PELO_SERVIDOR'],
    ['COMMIT respondido como ROLLBACK', {falharCommit: {n: 1, rollback: true}}, 'DESFEITA_PELO_SERVIDOR'],
  ];
  for (const [rotulo, opcoes, commit] of casos) {
    const dir = tmp();
    try {
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: clienteFalso(opcoes), disco: semDisco});
      assert.equal(r.resultado, 'FALHA', rotulo + JSON.stringify(r)); assert.deepEqual(r.commits, {109: commit}, rotulo);
      assert.match(r.reconciliar, /--conferir-109/); assert.match(r.reconciliar, /manter o cron suspenso/);
      const m = JSON.parse(fs.readFileSync(r.marcador, 'utf8'));
      assert.equal(m.situacao, 'FALHA'); assert.deepEqual(m.commits, {109: commit}, rotulo + ' (marcador)');
      await assert.rejects(stg.principal(['--aplicar-109-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso(), dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('retomada autorizada: COMMIT indeterminado que confirmou; marcador renomeado → nova execução só confere a capacidade', async () => {
  const dir = tmp();
  try {
    const r1 = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: clienteFalso({falharCommit: {n: 1, erro: erroPg('08006')}}), disco: semDisco});
    assert.deepEqual(r1.commits, {109: 'INDETERMINADO'});
    fs.renameSync(path.join(dir, comum.MARCADOR), path.join(dir, 'migration-109.2026-10-30T09-00.json'));
    const C2 = clienteFalso({retrato: '109', inicial: estado({sessoes_renovacao: 1, dono: false})});
    const r2 = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C2, disco: semDisco});
    assert.equal(r2.resultado, 'JA_APLICADA_CAPACIDADE_PASS', JSON.stringify(r2)); assert.deepEqual(r2.etapas, ['capacidade 109']); assert.deepEqual(r2.commits, {});
    assert.deepEqual(escritas(C2.log), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8')).tentativasAnteriores, ['migration-109.2026-10-30T09-00.json']);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('estado que não completa depois do COMMIT, contagens que mudam, recusas antes de escrever e disco ausente', async () => {
  for (const [opcoes, motivo, commits] of [[{naoCompleta: true}, /ESTADO_DEPOIS_109/, {109: 'CONFIRMADO'}],
    [{porEstadoDepois: [{estado: 'PENDENTE', n: 1}]}, /CONTAGENS_MUDARAM_109/, {109: 'CONFIRMADO'}],
    [{inicial: estado({sessoes_renovacao: 1})}, /RENOVACAO_EM_EXECUCAO 1/, {}], [{retrato: 'D'}, /RETRATO_DIVERGENTE_109/, {}],
    [{inicial: estado({pode_criar: false})}, /SEM_PRIVILEGIO_109 CREATE/, {}]]) {
    const dir = tmp();
    try {
      const C = clienteFalso({...opcoes, retrato: opcoes.retrato === 'D' ? derivado(R.RETRATO_075) : opcoes.retrato});
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, motivo); assert.deepEqual(r.commits, commits);
      if (!commits[109]) assert.deepEqual(escritas(C.log), [], 'recusa antes de qualquer escrita');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
  await assert.rejects(stg.executar({env: ENV_STG, backup: BACKUP, dir: tmp(), Client: clienteFalso(), disco: () => assert.fail('DISCO_PERSISTENTE_AUSENTE')}), /DISCO_PERSISTENTE_AUSENTE/);
  const dir2 = tmp();
  try {
    const x = await stg.principal(['--aplicar-109-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso({falharEm: 'CREATE UNIQUE INDEX assinatura_renovacoes_109_vigente_uq'}), dir: dir2, disco: semDisco});
    assert.equal(x.codigo, 2); assert.equal(x.saida.resultado, 'FALHA');
  } finally { fs.rmSync(dir2, {recursive: true, force: true}); }
});

test('plano sem conexão: 3 SQL + contrato com sha, prova no alvo, ordem com corte e cron suspenso, paradas; nunca o down', async () => {
  const {codigo, saida} = await stg.principal([], {});
  assert.equal(codigo, 0); assert.equal(saida.conecta, false); assert.equal(saida.ambiente, 'staging');
  assert.deepEqual(saida.arquivos.map(a => a.sha256), [...comum.ETAPAS.map(e => e[2]), ...comum.CONTRATO.map(e => e[1])]);
  assert.match(saida.provaNoAlvo, /antes do COMMIT/);
  // P3-2: os consumidores do plano §3, inclusive o cron da reconciliação, com execuções antigas drenadas.
  assert.match(saida.ordem[0], /commit do web, do cron da renovação e do cron da reconciliação/); assert.match(saida.ordem[0], /nenhuma execução antiga/);
  assert.ok(saida.preRequisitos.some(p => /cron da reconciliação \(crn-db493i142hec73ahmoe0/.test(p) && /drenadas/.test(p)));
  assert.match(saida.prazos, /statement_timeout 60s/); assert.match(saida.prazos, /NAO_COMMITADA/);
  await assert.rejects(stg.executar({env: ENV_STG, backup: BACKUP, dir: tmp(), Client: clienteFalso(), disco: semDisco, orcamento: '1 minute'}).then(x => { throw new Error(x.falha?.mensagem); }), /ORCAMENTO_INVALIDO/);
  assert.ok(saida.ordem.some(o => /PITR/.test(o)) && saida.ordem.some(o => /imediatamente antes/.test(o)) && saida.ordem.some(o => /cron da renovação SUSPENSO/.test(o)));
  assert.ok(saida.ordem.at(-1).startsWith('reativar o cron'));
  assert.ok(saida.preRequisitos.some(p => /QUEBRA/.test(p)) && saida.preRequisitos.some(p => /DONO de assinatura_renovacoes/.test(p)));
  assert.ok(saida.paradas.some(p => /nunca apagar/.test(p)) && saida.paradas.some(p => /INDETERMINADO/.test(p)) && saida.paradas.some(p => /manter o cron suspenso/.test(p)));
  assert.ok(saida.recuperacao.some(r => /SEM histórico de substituição/.test(r)) && saida.recuperacao.some(r => /correção para frente/.test(r)));
  assert.ok(saida.nuncaExecuta.includes('down 109') && saida.nuncaExecuta.some(n => /cron/.test(n)));
  assert.ok(!saida.arquivos.some(a => a.arquivo.includes('rollback')));
});

test('109 já aplicada e retrato que muda depois da capacidade (DDL concorrente): a releitura final recusa (ESTADO_FINAL_109)', async () => {
  const dir = tmp();
  try {
    // Leituras do retrato: estado antes (1) e capacidade (2) veem a 109; a releitura final (3) já vê a deriva.
    const C = clienteFalso({retrato: '109', retratoDepoisDe: {n: 2, retrato: derivado(R.RETRATO_109)}});
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'FALHA', JSON.stringify(r)); assert.match(r.falha.mensagem, /ESTADO_FINAL_109/); assert.deepEqual(r.commits, {});
    assert.deepEqual(escritas(C.log), []);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('conferência com o contrato TypeScript divergente do hash revisado: FALHA antes de conectar ao contrato, nada lido', async () => {
  const outra = fs.mkdtempSync(path.join(os.tmpdir(), 'raiz-109-'));
  try {
    for (const a of [...comum.ETAPAS.map(e => e[1]), ...comum.CONTRATO.map(e => e[0])]) {
      fs.mkdirSync(path.dirname(path.join(outra, a)), {recursive: true}); fs.copyFileSync(path.join(raiz, a), path.join(outra, a));
    }
    fs.appendFileSync(path.join(outra, comum.CONTRATO[0][0]), '\n// alterado\n');
    const C = clienteFalso();
    const r = await stg.conferir({env: ENV_STG, raiz: outra, Client: C});
    assert.equal(r.resultado, 'FALHA', JSON.stringify(r)); assert.match(r.mensagem, /ARQUIVO_DIVERGENTE lib\/assinatura\/renovacao-schema\.ts/);
    assert.ok(!C.log.some(x => x.sql === comum.SQL_ESTADO), 'nada lido do banco');
  } finally { fs.rmSync(outra, {recursive: true, force: true}); }
});
