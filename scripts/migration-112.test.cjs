/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 112 (cliente pessoa jurídica, staging) com cliente simulado que só CONFIRMA no COMMIT e descarta no
// ROLLBACK: hashes dos SQL, molduras, estado pelos 19 objetos do catálogo (ausente/presente/parcial), privilégios um a um,
// trava de alvo, conferência só leitura, migration sem o COMMIT final com preservação e postcheck na transação, situação do
// COMMIT (NAO_COMMITADA / CONFIRMADO / DESFEITA_PELO_SERVIDOR / INDETERMINADO, inclusive 40003), marcador anti-repetição e
// retomada pelo marcador renomeado. Sem rede nem banco (a prova real é lib/clientes/aplicador-112.postgres.test.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const comum = require('./migration-112-comum.cjs');
const {lerRevisado} = require('./migration-092-094-comum.cjs');
const stg = require('./migration-112-staging.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_STG = 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91';
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false', DATABASE_URL: URL_STG});
const ID_STG = {db: 'kidmais_staging_1z91', tls: false, servidor_privado: true};
const BACKUP = 'PITR 2026-11-01T09:00Z staging';
const ler = nome => { const [, a, h] = comum.ETAPAS.find(e => e[0] === nome); return lerRevisado(raiz, a, h); };
const M112 = ler('migration 112'), POS112 = ler('postcheck 112'), PRE112 = ler('precheck 112');
const C112 = comum.semCommitFinal(M112, 'm112');
const CORPO_PRE = comum.corpoSomenteLeitura(PRE112, 'pre'), CORPO_POS = comum.corpoSomenteLeitura(POS112, 'pos');
const erroPg = (code, msg = 'erro simulado') => Object.assign(new Error(msg), {code});
const CHEIO = Object.freeze(Object.fromEntries(Object.entries(comum.OBJETOS).map(([k, v]) => [k, v.length])));
const VAZIO = Object.freeze(Object.fromEntries(Object.keys(comum.OBJETOS).map(k => [k, 0])));
const privilegios = (extra = {}) => ({versao_pg: 180006, clientes: true, mesclagens: true, dono_clientes: true, dono_mesclagens: true, ler_clientes: true,
  usar_public: true, pode_criar: true, plpgsql: true, papel_trocado: true, ...extra});
const estado = (objetos = VAZIO, extra = {}) => ({...privilegios(extra), ...objetos});
const PLANO_TUDO = ['precheck 112', 'migration 112', 'postcheck 112'];
const POR_STATUS = [{status: 'ATIVO', n: 4}, {status: 'INATIVO', n: 1}, {status: 'MESCLADO', n: 1}];

/**
 * Cliente simulado transacional: o corpo da migration (sem COMMIT) deixa os 19 objetos PENDENTES; 'COMMIT' confirma e
 * 'ROLLBACK' descarta. SQL_ESTADO devolve o estado CONFIRMADO. Opções: aplicada (inicial), objetos (contagem inicial
 * explícita), extra (privilégios), falharEm (trecho que lança `erro`), falharCommit ({n, erro} ou {n, rollback: true}),
 * preservacao (o que a prova devolve), naoCompleta (COMMIT não deixa os objetos), objetosDepoisDe ({n, objetos}).
 */
function clienteFalso({aplicada = false, objetos, extra, identidade = ID_STG, falharEm, erro, falharCommit, preservacao, naoCompleta, objetosDepoisDe} = {}) {
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
      if (sql === comum.SQL_ESTADO) {
        if (objetosDepoisDe && ++leiturasEstado > objetosDepoisDe.n) atual.objetos = objetosDepoisDe.objetos;
        return {rows: [estado(atual.objetos, extra)]};
      }
      if (sql.startsWith('SELECT status::text')) return {rows: POR_STATUS};
      if (sql.startsWith('SELECT tipo_pessoa')) return {rows: [{tipo: 'PF', n: 6}]};
      if (sql === comum.SQL_PRESERVACAO) return {rows: [preservacao ?? {clientes_escritos: 0, mesclagens_escritas: 0}]};
      if (sql === C112) {
        assert.equal(ro, false, 'migration nunca em READ ONLY');
        pendente = {aplicar: () => { if (!naoCompleta) { atual.objetos = CHEIO; atual.aplicada = true; } }};
      }
      assert.notEqual(sql, M112, 'o arquivo COM o COMMIT final nunca é enviado');
      assert.ok(sql !== PRE112 && sql !== POS112, 'precheck/postcheck vão sem a própria moldura');
      return {rows: []};
    }
  };
  C.log = log; C.atual = atual;
  return C;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-112-'));
const semDisco = () => {};
const LEITURA = /^(BEGIN TRANSACTION READ ONLY|ROLLBACK|COMMIT|SET LOCAL|SELECT |\/\* preservacao-112 \*\/ SELECT)/;
const escritas = log => log.filter(x => !x.ro && !LEITURA.test(x.sql) && !x.emTransacao);

test('hashes dos 3 SQL; migration é UMA transação enviada sem o COMMIT final, com os prazos e a trava do próprio SQL', () => {
  for (const [, arquivo, hash] of comum.ETAPAS) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), hash, arquivo);
  assert.deepEqual(comum.ETAPAS.map(e => e[0]), PLANO_TUDO);
  assert.match(M112, /SET LOCAL lock_timeout = '5s';/); assert.match(M112, /SET LOCAL statement_timeout = '60s';/);
  assert.match(M112, /^LOCK TABLE clientes IN ACCESS EXCLUSIVE MODE;$/m);
  assert.doesNotMatch(M112.replace(/--.*$/gm, ''), /^\s*(UPDATE|DELETE|INSERT|TRUNCATE|COPY)\b/im, 'nenhum comando de escrita de linha');
  assert.equal(C112 + 'COMMIT;\n', M112, 'só o COMMIT final sai'); assert.doesNotMatch(C112, /^COMMIT;$/m);
  assert.throws(() => comum.semCommitFinal(M112 + 'COMMIT;\n', 'x'), /TRANSACAO_INESPERADA/);
  assert.throws(() => comum.semCommitFinal(M112.replace('BEGIN;\n', ''), 'x'), /TRANSACAO_INESPERADA/);
  for (const corpo of [CORPO_PRE, CORPO_POS]) { assert.match(corpo, /^SET LOCAL search_path = public, pg_catalog;\nDO \$\$/); assert.doesNotMatch(corpo, /^(BEGIN TRANSACTION|ROLLBACK;|COMMIT;)/m); }
  assert.throws(() => comum.corpoSomenteLeitura(POS112.replace('ROLLBACK;\n', 'COMMIT;\n'), 'x'), /MOLDURA_INESPERADA/);
  assert.throws(() => comum.corpoSomenteLeitura('BEGIN;\n' + POS112, 'x'), /MOLDURA_INESPERADA/);
  assert.throws(() => comum.corpoSomenteLeitura(POS112.replace('BEGIN TRANSACTION READ ONLY;\n', ''), 'x'), /MOLDURA_INESPERADA/);
  assert.throws(() => lerRevisado(raiz, comum.ETAPAS[1][1], 'f'.repeat(64)), /ARQUIVO_DIVERGENTE/);
});

test('os 19 objetos do estado são exatamente os que a 112 cria, o postcheck confere e o down remove', () => {
  assert.equal(comum.TOTAL_OBJETOS, 19);
  const down = fs.readFileSync(path.join(raiz, 'database/rollback/20261101_112_clientes_pessoa_juridica_down.sql'), 'utf8');
  for (const c of comum.OBJETOS.colunas) { assert.match(M112, new RegExp(`ADD COLUMN ${c} `)); assert.match(down, new RegExp(`DROP COLUMN ${c}[,;]`)); }
  for (const r of comum.OBJETOS.restricoes) { assert.match(M112, new RegExp(`ADD CONSTRAINT ${r} `)); assert.match(POS112, new RegExp(`'${r}'`)); assert.match(down, new RegExp(`DROP CONSTRAINT ${r}[,;]`)); }
  assert.equal((M112.match(/ADD CONSTRAINT /g) ?? []).length, comum.OBJETOS.restricoes.length);
  for (const i of comum.OBJETOS.indices) { assert.match(M112, new RegExp(`CREATE UNIQUE INDEX ${i}\\b`)); assert.match(down, new RegExp(`DROP INDEX public\\.${i};`)); }
  for (const f of comum.OBJETOS.funcoes) { const nome = f.slice(0, f.indexOf('(')); assert.match(M112, new RegExp(`CREATE FUNCTION ${nome}\\(`)); assert.match(down, new RegExp(`DROP FUNCTION public\\.${nome}\\(`)); }
  assert.equal((M112.match(/CREATE FUNCTION /g) ?? []).length, comum.OBJETOS.funcoes.length);
  for (const g of comum.OBJETOS.gatilhos) { assert.match(M112, new RegExp(`CREATE TRIGGER ${g}\\b`)); assert.match(POS112, new RegExp(`t\\.tgname = '${g}'`)); assert.match(down, new RegExp(`DROP TRIGGER ${g} `)); }
});

test('postcheck confere o corpo instalado das 3 funções: o sha256 esperado é o do texto entre $$ de cada CREATE FUNCTION da migration', () => {
  for (const f of comum.OBJETOS.funcoes) {
    const nome = f.slice(0, f.indexOf('('));
    const i = M112.indexOf(`CREATE FUNCTION ${nome}(`), a = M112.indexOf('$$', i) + 2, b = M112.indexOf('$$', a);
    const corpo = createHash('sha256').update(M112.slice(a, b)).digest('hex');
    assert.match(POS112, new RegExp(`'${nome}', jsonb_build_object\\('corpo', '${corpo}'`), nome);
  }
  assert.match(POS112, /encode\(sha256\(convert_to\(replace\(p\.prosrc, E'\\r', ''\), 'UTF8'\)\), 'hex'\)/);
  assert.match(POS112, /'definer', false/);
});

test('estado só lê catálogo e privilégios (nenhuma tabela de dados); preservação lê xmin do xid da transação', () => {
  const sem = comum.SQL_ESTADO.replace(/'[^']*'/g, "''");
  assert.doesNotMatch(sem, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|TRUNCATE)\b/);
  const fontes = [...comum.SQL_ESTADO.matchAll(/\bFROM\s+([a-z_.]+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(fontes)].sort(), ['pg_attribute', 'pg_class', 'pg_constraint', 'pg_trigger', 'unnest'], 'só catálogo');
  assert.match(comum.SQL_ESTADO, /pg_has_role\(current_user, relowner, 'USAGE'\) FROM pg_class WHERE oid = to_regclass\('public\.clientes'\)\), false\) AS dono_clientes/);
  assert.match(comum.SQL_ESTADO, /pg_has_role\(current_user, relowner, 'USAGE'\) FROM pg_class WHERE oid = to_regclass\('public\.mesclagens_clientes'\)\), false\) AS dono_mesclagens/);
  assert.match(comum.SQL_ESTADO, /has_schema_privilege\(current_user, 'public', 'CREATE'\) AS pode_criar/);
  assert.match(comum.SQL_ESTADO, /has_language_privilege\(current_user, 'plpgsql', 'USAGE'\)/);
  assert.match(comum.SQL_PRESERVACAO, /FROM public\.clientes WHERE xmin::text = \(pg_current_xact_id\(\)::text::bigint % 4294967296\)::text/);
  assert.match(comum.SQL_PRESERVACAO, /FROM public\.mesclagens_clientes WHERE xmin::text = /);
});

test('estado e plano: 0 objetos = ausente; 19 = presente (postcheck); parcial recusa com os grupos; privilégios de dono só no ausente', () => {
  assert.equal(comum.lerEstado(estado()).m112, 'ausente');
  assert.equal(comum.lerEstado(estado(CHEIO)).m112, 'presente');
  const parcial = comum.lerEstado(estado({...CHEIO, gatilhos: 1, colunas: 0}));
  assert.equal(parcial.m112, 'parcial'); assert.deepEqual(parcial.divergencias, ['colunas 0/6', 'gatilhos 1/2']);
  assert.throws(() => comum.lerEstado(estado(VAZIO, {dono_clientes: 'sim'})), /ESTADO_ILEGIVEL dono_clientes/);
  assert.throws(() => comum.lerEstado(estado({...VAZIO, funcoes: 4})), /ESTADO_ILEGIVEL funcoes/);
  assert.throws(() => comum.lerEstado(estado({...VAZIO, colunas: -1})), /ESTADO_ILEGIVEL colunas/);
  const p = (objetos, extra) => comum.planoEtapas(comum.lerEstado(estado(objetos, extra)));
  assert.deepEqual(p(VAZIO), PLANO_TUDO);
  assert.deepEqual(p(CHEIO), ['postcheck 112']);
  for (const [o, e, re] of [[{...VAZIO, indices: 1}, {}, / APLICACAO_PARCIAL_112 colunas 0\/6, restricoes 0\/7, funcoes 0\/3, gatilhos 0\/2$/], [VAZIO, {clientes: false}, /TABELA_AUSENTE clientes$/],
    [VAZIO, {mesclagens: false}, /TABELA_AUSENTE mesclagens_clientes$/],
    [VAZIO, {usar_public: false}, /SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC$/], [CHEIO, {ler_clientes: false}, /SEM_PRIVILEGIO_LEITURA SELECT_CLIENTES$/],
    [VAZIO, {dono_clientes: false}, /SEM_PRIVILEGIO_112 DONO_CLIENTES$/], [VAZIO, {dono_mesclagens: false}, /SEM_PRIVILEGIO_112 DONO_MESCLAGENS$/],
    [VAZIO, {pode_criar: false}, /SEM_PRIVILEGIO_112 CREATE$/], [VAZIO, {plpgsql: false, dono_clientes: false}, /SEM_PRIVILEGIO_112 DONO_CLIENTES LINGUAGEM$/]]) {
    assert.throws(() => p(o, e), re, JSON.stringify(e));
  }
  assert.deepEqual(p(CHEIO, {dono_clientes: false, dono_mesclagens: false, pode_criar: false, plpgsql: false}), ['postcheck 112'], 'dono/CREATE só com a 112 ausente');
});

test('situação do COMMIT: 40003 e classes 08/57/58/XX ou sem SQLSTATE = INDETERMINADO; demais SQLSTATE = desfeita', () => {
  for (const [e, esperado] of [[erroPg('40003'), 'INDETERMINADO'], [erroPg('57014'), 'INDETERMINADO'], [erroPg('08006'), 'INDETERMINADO'], [erroPg('XX000'), 'INDETERMINADO'],
    [new Error('Connection terminated unexpectedly'), 'INDETERMINADO'], [erroPg('23505'), 'DESFEITA_PELO_SERVIDOR'], [erroPg('P0001'), 'DESFEITA_PELO_SERVIDOR']]) {
    assert.equal(comum.commitNaFalha(e), esperado, String(e.code ?? e.message));
  }
});

test('trava de alvo de staging e identidade: serviço, ambiente, host, banco, porta, URL sem query; mensagem sem segredos', async () => {
  assert.equal(stg.alvo(ENV_STG).application_name, 'kidmais-migration-112-staging');
  assert.equal(stg.alvo({...ENV_STG, DATABASE_SSL: 'true'}).ssl.rejectUnauthorized, true);
  for (const [mudanca, erro] of [[{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg'}, /SERVICO_RECUSADO/], [{KIDMAIS_DEPLOY_ENV: 'production'}, /AMBIENTE_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace('dpg-daidko3m8hqs73ce4jt0-a', 'dpg-outro.render.com')}, /HOST_RECUSADO/], [{DATABASE_URL: URL_STG.replace('kidmais_staging_1z91', 'kidmais_manager')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace(':5432', ':5433')}, /PORTA_RECUSADA/], [{DATABASE_URL: URL_STG + '?sslmode=disable'}, /CONNECTION_QUERY_REJECTED/],
    [{DATABASE_SSL: 'talvez'}, /TLS_CONFIGURACAO_RECUSADA/], [{DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false'}, /TLS_CONFIGURACAO_RECUSADA/],
    [{DATABASE_URL: 'nao-e-url'}, /URL_RECUSADA/]]) {
    assert.throws(() => stg.alvo({...ENV_STG, ...mudanca}), (e) => erro.test(e.message) && !e.message.includes('SENHA_FALSA'), JSON.stringify(mudanca));
  }
  const outro = await stg.conferir({env: ENV_STG, Client: clienteFalso({identidade: {...ID_STG, db: 'outro_banco'}})});
  assert.equal(outro.resultado, 'FALHA'); assert.match(outro.mensagem, /IDENTIDADE_RECUSADA/); assert.ok(!JSON.stringify(outro).includes('SENHA_FALSA'));
  assert.equal(stg.DIR, '/opt/render/project/src/data/clientes-pj-112-staging');
});

test('conferência: só leitura com search_path fixo, nada no disco; ausente = precheck; presente = postcheck; contagens', async () => {
  const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
  fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
  try {
    const Pronta = clienteFalso();
    const r = await stg.conferir({env: ENV_STG, Client: Pronta});
    assert.equal(r.resultado, 'PRONTA_PARA_APLICAR', JSON.stringify(r));
    assert.deepEqual(r.checks, {'precheck 112': 'PASS'}); assert.deepEqual(r.plano, PLANO_TUDO);
    assert.equal(r.estado.objetos, 0); assert.deepEqual(r.contagens, {total: 6, porStatus: {ATIVO: 4, INATIVO: 1, MESCLADO: 1}});
    assert.deepEqual(escritas(Pronta.log), []);
    const leituras = Pronta.log.filter(x => /^SELECT|^SET LOCAL search_path = public, pg_catalog;\nDO/.test(x.sql));
    assert.ok(leituras.length > 0 && leituras.every(x => x.ro), 'toda consulta dentro de READ ONLY');
    assert.ok(Pronta.log.some(x => x.ro && x.sql === CORPO_PRE)); assert.ok(!Pronta.log.some(x => x.sql === C112 || x.sql.startsWith('SELECT tipo_pessoa')));
    assert.ok(Pronta.log.filter(x => x.sql === 'SET LOCAL search_path = public, pg_catalog').length >= 3);
    const Aplicada = clienteFalso({aplicada: true});
    const j = await stg.conferir({env: ENV_STG, Client: Aplicada});
    assert.equal(j.resultado, 'JA_APLICADA_POSTCHECK_PASS', JSON.stringify(j));
    assert.deepEqual(j.checks, {'postcheck 112': 'PASS'}); assert.deepEqual(j.contagens.porTipo, {PF: 6});
    assert.ok(Aplicada.log.some(x => x.ro && x.sql === CORPO_POS) && !Aplicada.log.some(x => x.sql === CORPO_PRE));
    assert.deepEqual(escritas(Aplicada.log), []);
  } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
  assert.deepEqual(gravacoes, [], 'a conferência não grava arquivos');
  for (const [opcoes, motivo, sohCatalogo] of [[{objetos: {...VAZIO, colunas: 6}}, /APLICACAO_PARCIAL_112 restricoes 0\/7, indices 0\/1, funcoes 0\/3, gatilhos 0\/2$/, true],
    [{extra: {dono_mesclagens: false}}, /SEM_PRIVILEGIO_112 DONO_MESCLAGENS/, true],
    [{falharEm: "'112 precheck: 076 ausente", erro: erroPg('P0001', '112 precheck: 076 ausente (CPF único por empresa)')}, /112 precheck: 076 ausente/, false],
    [{aplicada: true, falharEm: '112 postcheck: gatilhos', erro: erroPg('P0001', '112 postcheck: gatilhos de mesclagem ausentes ou divergentes')}, /112 postcheck: gatilhos/, false]]) {
    const C = clienteFalso(opcoes);
    const x = await stg.principal(['--conferir-112'], ENV_STG, {Client: C});
    assert.equal(x.codigo, 3, JSON.stringify(x)); assert.equal(x.saida.resultado, 'RECUSARIA'); assert.match(x.saida.motivo, motivo);
    if (sohCatalogo) assert.ok(!C.log.some(y => y.sql === CORPO_PRE || y.sql.startsWith('SELECT status::text')), 'nada lido além do catálogo');
  }
  assert.equal((await stg.principal(['--conferir-112'], ENV_STG, {Client: clienteFalso()})).codigo, 0);
  await assert.rejects(stg.principal(['--conferir-112'], {...ENV_STG, RENDER_SERVICE_ID: 'srv-x'}, {Client: clienteFalso()}), /SERVICO_RECUSADO/);
});

test('aplicação: corpo sem COMMIT → preservação e postcheck NA transação → COMMIT → postcheck READ ONLY; contagens; marcador', async () => {
  await assert.rejects(stg.principal(['--aplicar-112-autorizado'], ENV_STG, {Client: clienteFalso()}), /BACKUP_OBRIGATORIO/);
  await assert.rejects(stg.principal(['--aplicar-112-autorizado', '--backup', 'x;rm'], ENV_STG, {Client: clienteFalso()}), /BACKUP_INVALIDO/);
  await assert.rejects(stg.principal(['--aplicar-109-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso()}), /ARGUMENTOS_RECUSADOS/);
  await assert.rejects(stg.principal(['--conferir-112', '--extra'], ENV_STG, {Client: clienteFalso()}), /ARGUMENTOS_RECUSADOS/);
  const dir = tmp();
  try {
    const C = clienteFalso();
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r));
    assert.deepEqual(r.etapas, PLANO_TUDO); assert.deepEqual(r.commits, {112: 'CONFIRMADO'}); assert.deepEqual(r.commitadas, ['112']);
    assert.equal(r.estadoAntes.m112, 'ausente'); assert.equal(r.estadoDepois.m112, 'presente');
    assert.deepEqual(r.contagensDepois.porStatus, r.contagensAntes.porStatus); assert.deepEqual(r.contagensDepois.porTipo, {PF: 6});
    assert.deepEqual(escritas(C.log).map(x => x.sql), [C112], 'só o corpo (sem COMMIT) escreve');
    const i = C.log.findIndex(x => x.sql === C112), iCommit = C.log.findIndex((x, k) => k > i && x.sql === 'COMMIT');
    assert.ok(iCommit > i);
    const kPres = C.log.findIndex((x, n) => n > i && x.sql === comum.SQL_PRESERVACAO), kPos = C.log.findIndex((x, n) => n > i && x.sql === CORPO_POS);
    assert.ok(i < kPres && kPres < kPos && kPos < iCommit, 'preservação, depois postcheck, antes do COMMIT');
    for (const k of [kPres, kPos]) assert.ok(C.log[k].emTransacao && !C.log[k].ro, 'na transação da migration');
    assert.equal(C.log[i - 1].sql, 'ROLLBACK', 'o corpo abre a própria transação logo depois da última leitura');
    assert.ok(C.log.slice(0, i).some(x => x.ro && x.sql === CORPO_PRE), 'precheck em READ ONLY antes');
    assert.ok(C.log.slice(iCommit + 1).some(x => x.ro && x.sql === CORPO_POS), 'postcheck de novo em READ ONLY depois do COMMIT');
    assert.ok(!C.log.some(x => /^SET statement_timeout|^RESET/.test(x.sql)), 'prazos só os do SQL (SET LOCAL)');
    const m = JSON.parse(fs.readFileSync(r.marcador, 'utf8'));
    assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.backup, BACKUP); assert.deepEqual(m.commits, {112: 'CONFIRMADO'});
    assert.deepEqual(m.etapas.find(e => e.nome === 'migration 112').antesDoCommit, {preservacao: 'PASS', 'postcheck 112': 'PASS'});
    assert.ok(!fs.readFileSync(r.marcador, 'utf8').includes('SENHA_FALSA'));
    await assert.rejects(stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: clienteFalso(), disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('preservação divergente DENTRO da transação (linha escrita pela migration): ROLLBACK, nada confirmado', async () => {
  for (const preservacao of [{clientes_escritos: 3, mesclagens_escritas: 0}, {clientes_escritos: 0, mesclagens_escritas: 1}, undefined]) {
    const dir = tmp();
    try {
      const C = clienteFalso({preservacao: preservacao ?? {}});
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /PRESERVACAO_112 clientes=/);
      assert.deepEqual(r.commits, {112: 'NAO_COMMITADA'}); assert.deepEqual(r.commitadas, []);
      const i = C.log.findIndex(x => x.sql === C112);
      assert.ok(!C.log.slice(i).some(x => x.sql === 'COMMIT'), 'COMMIT nunca enviado'); assert.ok(C.log.slice(i).some(x => x.sql === 'ROLLBACK'));
      assert.ok(!C.log.slice(i).some(x => x.sql === CORPO_POS), 'postcheck nem chega a rodar');
      assert.equal(C.atual.aplicada, false, 'nada confirmado');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('situação do COMMIT na aplicação: corpo/verificação = NAO_COMMITADA; COMMIT 40003/08/57/sem resposta = INDETERMINADO; recusa = desfeita', async () => {
  const casos = [
    ['corpo (lock_timeout)', {falharEm: 'LOCK TABLE clientes IN ACCESS EXCLUSIVE MODE', erro: erroPg('55P03')}, 'NAO_COMMITADA'],
    ['corpo (conexão caiu)', {falharEm: 'ADD COLUMN tipo_pessoa', erro: new Error('Connection terminated unexpectedly')}, 'NAO_COMMITADA'],
    ['corpo (statement_timeout do SQL)', {falharEm: 'CREATE UNIQUE INDEX clientes_cnpj_empresa_canonico_uk', erro: erroPg('57014', 'canceling statement due to statement timeout')}, 'NAO_COMMITADA'],
    ['preservação (conexão caiu)', {falharEm: 'preservacao-112', erro: erroPg('08006')}, 'NAO_COMMITADA'],
    ['postcheck na transação', {falharEm: '112 postcheck: colunas', erro: erroPg('P0001')}, 'NAO_COMMITADA'],
    ['COMMIT 40003', {falharCommit: {n: 1, erro: erroPg('40003')}}, 'INDETERMINADO'],
    ['COMMIT 08006', {falharCommit: {n: 1, erro: erroPg('08006')}}, 'INDETERMINADO'],
    ['COMMIT 57014', {falharCommit: {n: 1, erro: erroPg('57014')}}, 'INDETERMINADO'],
    ['COMMIT sem resposta', {falharCommit: {n: 1, erro: new Error('Connection terminated unexpectedly')}}, 'INDETERMINADO'],
    ['COMMIT recusado (23514)', {falharCommit: {n: 1, erro: erroPg('23514')}}, 'DESFEITA_PELO_SERVIDOR'],
    ['COMMIT respondido como ROLLBACK', {falharCommit: {n: 1, rollback: true}}, 'DESFEITA_PELO_SERVIDOR'],
  ];
  for (const [rotulo, opcoes, commit] of casos) {
    const dir = tmp();
    try {
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: clienteFalso(opcoes), disco: semDisco});
      assert.equal(r.resultado, 'FALHA', rotulo + JSON.stringify(r)); assert.deepEqual(r.commits, {112: commit}, rotulo);
      assert.equal(r.falha.etapa, 'migration 112', rotulo); assert.match(r.reconciliar, /--conferir-112/);
      const m = JSON.parse(fs.readFileSync(r.marcador, 'utf8'));
      assert.equal(m.situacao, 'FALHA'); assert.deepEqual(m.commits, {112: commit}, rotulo + ' (marcador)');
      await assert.rejects(stg.principal(['--aplicar-112-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso(), dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('retomada autorizada: COMMIT indeterminado que confirmou; marcador renomeado → nova execução só roda o postcheck', async () => {
  const dir = tmp();
  try {
    const r1 = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: clienteFalso({falharCommit: {n: 1, erro: erroPg('08006')}}), disco: semDisco});
    assert.deepEqual(r1.commits, {112: 'INDETERMINADO'});
    fs.renameSync(path.join(dir, comum.MARCADOR), path.join(dir, 'migration-112.2026-11-01T09-00.json'));
    const C2 = clienteFalso({aplicada: true, extra: {dono_clientes: false, pode_criar: false}});
    const r2 = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C2, disco: semDisco});
    assert.equal(r2.resultado, 'JA_APLICADA_POSTCHECK_PASS', JSON.stringify(r2)); assert.deepEqual(r2.etapas, ['postcheck 112']); assert.deepEqual(r2.commits, {});
    assert.deepEqual(escritas(C2.log), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8')).tentativasAnteriores, ['migration-112.2026-11-01T09-00.json']);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('estado que não completa depois do COMMIT, deriva depois do postcheck, recusas antes de escrever e disco ausente', async () => {
  for (const [opcoes, motivo, commits] of [[{naoCompleta: true}, /ESTADO_DEPOIS_112/, {112: 'CONFIRMADO'}],
    [{aplicada: true, objetosDepoisDe: {n: 1, objetos: {...CHEIO, gatilhos: 1}}}, /ESTADO_FINAL_112/, {}],
    [{objetos: {...VAZIO, funcoes: 2}}, /APLICACAO_PARCIAL_112 .*funcoes 2\/3/, {}], [{extra: {pode_criar: false}}, /SEM_PRIVILEGIO_112 CREATE/, {}],
    [{extra: {dono_clientes: false}}, /SEM_PRIVILEGIO_112 DONO_CLIENTES/, {}]]) {
    const dir = tmp();
    try {
      const C = clienteFalso(opcoes);
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'FALHA', JSON.stringify(r)); assert.match(r.falha.mensagem, motivo); assert.deepEqual(r.commits, commits);
      if (!commits[112]) assert.deepEqual(escritas(C.log), [], 'recusa antes de qualquer escrita');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
  const dir1 = tmp();
  try { await assert.rejects(stg.executar({env: ENV_STG, backup: BACKUP, dir: dir1, Client: clienteFalso(), disco: () => assert.fail('DISCO_PERSISTENTE_AUSENTE')}), /DISCO_PERSISTENTE_AUSENTE/);
    assert.deepEqual(fs.readdirSync(dir1), [], 'sem disco, nenhum marcador');
    // executar chamado direto (sem a CLI): backup ausente ou inseguro recusa antes do marcador e da conexão.
    for (const backup of [undefined, '', 'curto', 'x;rm -rf /', 'PITR ok\nx']) {
      const C = clienteFalso();
      await assert.rejects(stg.executar({env: ENV_STG, backup, dir: dir1, Client: C, disco: semDisco}), /BACKUP_OBRIGATORIO/, JSON.stringify(backup));
      assert.deepEqual(C.log, [], 'nada enviado ao banco');
    }
    assert.deepEqual(fs.readdirSync(dir1), [], 'backup recusado, nenhum marcador'); }
  finally { fs.rmSync(dir1, {recursive: true, force: true}); }
  const dir2 = tmp();
  try {
    const x = await stg.principal(['--aplicar-112-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso({falharEm: 'CREATE TRIGGER clientes_112'}), dir: dir2, disco: semDisco});
    assert.equal(x.codigo, 2); assert.equal(x.saida.resultado, 'FALHA');
  } finally { fs.rmSync(dir2, {recursive: true, force: true}); }
});

test('SQL revisado divergente: plano, conferência e aplicação recusam antes de conectar ou de ler o banco', async () => {
  const outra = fs.mkdtempSync(path.join(os.tmpdir(), 'raiz-112-'));
  try {
    for (const [, a] of comum.ETAPAS) { fs.mkdirSync(path.dirname(path.join(outra, a)), {recursive: true}); fs.copyFileSync(path.join(raiz, a), path.join(outra, a)); }
    fs.appendFileSync(path.join(outra, comum.ETAPAS[1][1]), '\n-- alterado\n');
    assert.throws(() => stg.plano({raiz: outra}), /ARQUIVO_DIVERGENTE database\/migrations\/20261101_112/);
    const dir = tmp();
    try {
      await assert.rejects(stg.executar({env: ENV_STG, backup: BACKUP, dir, raiz: outra, Client: clienteFalso(), disco: semDisco}), /ARQUIVO_DIVERGENTE/);
      assert.deepEqual(fs.readdirSync(dir), [], 'nenhum marcador');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    fs.copyFileSync(path.join(raiz, comum.ETAPAS[1][1]), path.join(outra, comum.ETAPAS[1][1]));
    fs.appendFileSync(path.join(outra, comum.ETAPAS[0][1]), '\n-- alterado\n');
    const C = clienteFalso();
    const r = await stg.conferir({env: ENV_STG, raiz: outra, Client: C});
    assert.equal(r.resultado, 'RECUSARIA', JSON.stringify(r)); assert.match(r.motivo, /ARQUIVO_DIVERGENTE database\/checks\/20261101_112_precheck/);
    assert.ok(!C.log.some(x => x.sql === CORPO_PRE), 'precheck divergente nunca enviado');
  } finally { fs.rmSync(outra, {recursive: true, force: true}); }
});

test('plano sem conexão: 3 SQL com sha, prova no alvo, prazos do SQL, ordem com PITR e autorização, paradas; nunca o down', async () => {
  const {codigo, saida} = await stg.principal([], {});
  assert.equal(codigo, 0); assert.equal(saida.conecta, false); assert.equal(saida.ambiente, 'staging');
  assert.deepEqual(saida.arquivos.map(a => a.sha256), comum.ETAPAS.map(e => e[2]));
  assert.match(saida.provaNoAlvo, /preservação/); assert.match(saida.provaNoAlvo, /antes do COMMIT/);
  assert.match(saida.prazos, /lock_timeout 5 s e statement_timeout 60 s do próprio SQL/);
  assert.ok(saida.ordem.some(o => /PITR/.test(o)) && saida.ordem.some(o => /autorização de Felipe para a 112/.test(o)) && saida.ordem.some(o => /imediatamente antes/.test(o)));
  assert.ok(saida.preRequisitos.some(p => /DONO de clientes e de mesclagens_clientes/.test(p)));
  assert.ok(saida.paradas.some(p => /nunca apagar/.test(p)) && saida.paradas.some(p => /INDETERMINADO/.test(p)));
  assert.ok(saida.recuperacao.some(r => /SEM nenhum dado de PJ/.test(r)) && saida.recuperacao.some(r => /correção para frente/.test(r)));
  assert.ok(saida.nuncaExecuta.includes('down 112'));
  assert.ok(!saida.arquivos.some(a => a.arquivo.includes('rollback')));
  assert.equal(JSON.stringify(saida).includes('DATABASE_URL'), false);
});
