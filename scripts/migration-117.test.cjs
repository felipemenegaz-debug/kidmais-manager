/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 117 (atendimento WhatsApp multiempresa, staging) com cliente simulado que só CONFIRMA no COMMIT e descarta no
// ROLLBACK: hashes dos SQL, molduras, estado pelos 3 objetos do catálogo (ausente/presente/parcial), privilégios um a um,
// trava de alvo, conferência só leitura, migration sem o COMMIT final com preservação (2 tabelas existentes) e postcheck na
// transação, situação do COMMIT (NAO_COMMITADA / CONFIRMADO / DESFEITA_PELO_SERVIDOR / INDETERMINADO, inclusive 40003),
// marcador anti-repetição e retomada pelo marcador renomeado. Rodada 2 (Astra r1): chave MULTI precisa estar desligada,
// EPIPE no COMMIT = INDETERMINADO, índices inválidos recusam, USAGE em public antes do to_regclass. Sem rede nem banco (a prova real é
// lib/whatsapp/atendimento/aplicador-117.postgres.test.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const comum = require('./migration-117-comum.cjs');
const {lerRevisado} = require('./migration-092-094-comum.cjs');
const stg = require('./migration-117-staging.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_STG = 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91';
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false', DATABASE_URL: URL_STG});
const ID_STG = {db: 'kidmais_staging_1z91', tls: false, servidor_privado: true};
const BACKUP = 'PITR 2026-11-04T22:00Z staging';
const ler = nome => { const [, a, h] = comum.ETAPAS.find(e => e[0] === nome); return lerRevisado(raiz, a, h); };
const M117 = ler('migration 117'), POS117 = ler('postcheck 117'), PRE117 = ler('precheck 117');
const DOWN117 = fs.readFileSync(path.join(raiz, 'database/rollback/20261104_117_atendimento_multiempresa_down.sql'), 'utf8').replace(/\r\n/g, '\n');
const C117 = comum.semCommitFinal(M117, 'm117');
const CORPO_PRE = comum.corpoSomenteLeitura(PRE117, 'pre'), CORPO_POS = comum.corpoSomenteLeitura(POS117, 'pos');
const erroPg = (code, msg = 'erro simulado') => Object.assign(new Error(msg), {code, severity: 'ERROR'});
const erroNode = (code, syscall = 'write') => Object.assign(new Error(code + ' simulado'), {code, errno: -32, syscall});
const CHEIO = Object.freeze(Object.fromEntries(Object.entries(comum.OBJETOS).map(([k, v]) => [k, v.length])));
const VAZIO = Object.freeze(Object.fromEntries(Object.keys(comum.OBJETOS).map(k => [k, 0])));
const privilegios = (extra = {}) => ({versao_pg: 180006, empresas: true, mensagens: true, status: true, dono_mensagens: true, referencias_empresas: true,
  ler_empresas: true, ler_mensagens: true, ler_rodizio: true, ler_colisoes: true, usar_public: true, pode_criar: true, plpgsql: true, papel_trocado: true, indices_invalidos: [], ...extra});
const estado = (objetos = VAZIO, extra = {}) => ({...privilegios(extra), ...objetos});
const PLANO_TUDO = ['precheck 117', 'migration 117', 'postcheck 117'];
const MENSAGENS = [{chave: 'staging:ENTRADA', n: 7}, {chave: 'staging:SAIDA', n: 5}];
const ZERO = Object.freeze(Object.fromEntries(comum.PRESERVADAS.map(t => [t, 0])));

/**
 * Cliente simulado transacional: o corpo da migration (sem COMMIT) deixa os 3 objetos PENDENTES; 'COMMIT' confirma e
 * 'ROLLBACK' descarta. SQL_ESTADO devolve o estado CONFIRMADO. Opções: aplicada (inicial), objetos (contagem inicial
 * explícita), extra (privilégios), falharEm (trecho que lança `erro`), falharCommit ({n, erro} ou {n, rollback: true}),
 * preservacao (o que a prova devolve), naoCompleta (COMMIT não deixa os objetos), objetosDepoisDe ({n, objetos}).
 */
function clienteFalso({aplicada = false, objetos, extra, identidade = ID_STG, falharEm, erro, falharCommit, preservacao, naoCompleta, objetosDepoisDe, semUsagePublic, invalidosNaTransacao} = {}) {
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
        // Sem USAGE em public, o to_regclass qualificado do estado falharia no servidor.
        if (semUsagePublic) throw erroPg('42501', 'permission denied for schema public');
        if (objetosDepoisDe && ++leiturasEstado > objetosDepoisDe.n) atual.objetos = objetosDepoisDe.objetos;
        return {rows: [estado(atual.objetos, extra)]};
      }
      if (sql === comum.SQL_MENSAGENS) return {rows: MENSAGENS};
      if (sql === comum.SQL_NOVAS) return {rows: [{rodizio: 0, colisoes: 0}]};
      if (sql === comum.SQL_PRESERVACAO) return {rows: [preservacao ?? ZERO]};
      if (sql === comum.SQL_INDICES_INVALIDOS) return {rows: [{invalidos: invalidosNaTransacao ?? []}]};
      if (sql === C117) {
        assert.equal(ro, false, 'migration nunca em READ ONLY');
        pendente = {aplicar: () => { if (!naoCompleta) { atual.objetos = CHEIO; atual.aplicada = true; } }};
      }
      assert.notEqual(sql, M117, 'o arquivo COM o COMMIT final nunca é enviado');
      assert.ok(sql !== PRE117 && sql !== POS117, 'precheck/postcheck vão sem a própria moldura');
      return {rows: []};
    }
  };
  C.log = log; C.atual = atual;
  return C;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-117-'));
const semDisco = () => {};
const LEITURA = /^(BEGIN TRANSACTION READ ONLY|ROLLBACK|COMMIT|SET LOCAL|SELECT |\/\* (preservacao|indices)-117 \*\/ SELECT)/;
const escritas = log => log.filter(x => !x.ro && !LEITURA.test(x.sql) && !x.emTransacao);

test('hashes dos 3 SQL; migration é UMA transação enviada sem o COMMIT final, com os prazos do próprio SQL e só DDL', () => {
  for (const [, arquivo, hash] of comum.ETAPAS) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), hash, arquivo);
  assert.deepEqual(comum.ETAPAS.map(e => e[0]), PLANO_TUDO);
  assert.match(M117, /SET LOCAL lock_timeout = '5s';/); assert.match(M117, /SET LOCAL statement_timeout = '60s';/);
  assert.match(M117, /SET LOCAL search_path = public, pg_catalog;/);
  assert.doesNotMatch(M117.replace(/--.*$/gm, ''), /^\s*(UPDATE|DELETE|INSERT|TRUNCATE|COPY|ALTER|DROP)\b/im, 'nenhuma escrita de linha nem alteração de objeto existente');
  assert.equal(C117 + 'COMMIT;\n', M117, 'só o COMMIT final sai'); assert.doesNotMatch(C117, /^COMMIT;$/m);
  assert.throws(() => comum.semCommitFinal(M117 + 'COMMIT;\n', 'x'), /TRANSACAO_INESPERADA/);
  assert.throws(() => comum.semCommitFinal(M117.replace('BEGIN;\n', ''), 'x'), /TRANSACAO_INESPERADA/);
  for (const corpo of [CORPO_PRE, CORPO_POS]) { assert.match(corpo, /^SET LOCAL search_path = public, pg_catalog;\nDO \$\$/); assert.doesNotMatch(corpo, /^(BEGIN TRANSACTION|ROLLBACK;|COMMIT;)/m); }
  assert.throws(() => comum.corpoSomenteLeitura(POS117.replace('ROLLBACK;\n', 'COMMIT;\n'), 'x'), /MOLDURA_INESPERADA/);
  assert.throws(() => comum.corpoSomenteLeitura('BEGIN;\n' + POS117, 'x'), /MOLDURA_INESPERADA/);
  assert.throws(() => comum.corpoSomenteLeitura(POS117.replace('BEGIN TRANSACTION READ ONLY;\n', ''), 'x'), /MOLDURA_INESPERADA/);
  assert.throws(() => lerRevisado(raiz, comum.ETAPAS[1][1], 'f'.repeat(64)), /ARQUIVO_DIVERGENTE/);
});

test('os 3 objetos do estado são exatamente os que a 117 cria, o postcheck confere e o down remove; as 2 preservadas são as que ela trava', () => {
  assert.equal(comum.TOTAL_OBJETOS, 3);
  for (const t of comum.OBJETOS.tabelas) { assert.match(M117, new RegExp(`^CREATE TABLE ${t} \\(`, 'm')); assert.match(POS117, new RegExp(`"${t}": \\{`)); assert.match(DOWN117, new RegExp(`DROP TABLE public\\.${t};`)); }
  assert.equal((M117.match(/^CREATE TABLE /gm) ?? []).length, comum.OBJETOS.tabelas.length);
  for (const i of comum.OBJETOS.indices) { assert.match(M117, new RegExp(`^CREATE INDEX IF NOT EXISTS ${i}\\n  ON whatsapp_atendimento_mensagens `, 'm')); assert.match(POS117, new RegExp(`CREATE INDEX ${i} ON public\\.whatsapp_atendimento_mensagens`)); assert.match(DOWN117, new RegExp(`DROP INDEX IF EXISTS public\\.${i};`)); }
  // Os outros índices da 117 pertencem às tabelas novas (somem com elas); só o índice de busca toca tabela existente.
  const indicesTabelaExistente = [...M117.matchAll(/^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?(\S+)\s+ON (\S+)/gm)].filter(m => !comum.OBJETOS.tabelas.includes(m[2])).map(m => m[1]);
  assert.deepEqual(indicesTabelaExistente, [...comum.OBJETOS.indices]);
  // As tabelas existentes que a 117 toca: a referenciada pela FK nova e a do índice novo — exatamente as preservadas.
  const referenciadas = [...M117.matchAll(/REFERENCES ([a-z_]+) \(/g)].map(m => m[1]);
  const indexadas = [...M117.matchAll(/^\s*ON ([a-z_]+) \(/gm)].map(m => m[1]).filter(t => !comum.OBJETOS.tabelas.includes(t));
  assert.deepEqual([...new Set([...referenciadas, ...indexadas])].sort(), [...comum.PRESERVADAS].sort());
});

test('estado só lê catálogo e privilégios (nenhuma tabela de dados); preservação lê xmin das 2 tabelas', () => {
  const sem = comum.SQL_ESTADO.replace(/'[^']*'/g, "''");
  assert.doesNotMatch(sem, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|TRUNCATE)\b/);
  const fontes = [...comum.SQL_ESTADO.matchAll(/\bFROM\s+([a-z_.]+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(fontes)].sort(), ['pg_class', 'pg_index', 'unnest'], 'só catálogo');
  // Validade dos índices da 117 (das 2 tabelas novas e o de busca): válido, pronto e ativo; o mesmo SQL roda na transação.
  for (const sql of [comum.SQL_ESTADO, comum.SQL_INDICES_INVALIDOS]) {
    assert.match(sql, /NOT \(x\.indisvalid AND x\.indisready AND x\.indislive\)/);
    assert.match(sql, /x\.indrelid IN \(to_regclass\('public\.whatsapp_atendimento_rodizio'\), to_regclass\('public\.whatsapp_atendimento_status_colisoes'\)\)/);
    assert.match(sql, /x\.indexrelid = to_regclass\('public\.whatsapp_atendimento_mensagens_ambiente_provedor_idx'\)/);
  }
  assert.doesNotMatch(comum.SQL_USAGE_PUBLIC, /to_regclass/, 'USAGE em public conferido sem resolver nome qualificado');
  assert.match(comum.SQL_ESTADO, /pg_has_role\(current_user, relowner, 'USAGE'\) FROM pg_class WHERE oid = to_regclass\('public\.whatsapp_atendimento_mensagens'\)\), false\) AS dono_mensagens/);
  assert.match(comum.SQL_ESTADO, /has_table_privilege\(current_user, oid, 'REFERENCES'\) FROM pg_class WHERE oid = to_regclass\('public\.empresas'\)\), false\) AS referencias_empresas/);
  assert.match(comum.SQL_ESTADO, /has_schema_privilege\(current_user, 'public', 'CREATE'\) AS pode_criar/);
  assert.match(comum.SQL_ESTADO, /has_language_privilege\(current_user, 'plpgsql', 'USAGE'\)/);
  for (const t of comum.PRESERVADAS) assert.match(comum.SQL_PRESERVACAO, new RegExp(`FROM public\\.${t} WHERE xmin::text = \\(pg_current_xact_id\\(\\)::text::bigint % 4294967296\\)::text\\)::int AS ${t}`));
  // Contagens sem conteúdo, telefone nem identificador.
  assert.doesNotMatch(comum.SQL_MENSAGENS + comum.SQL_NOVAS, /conteudo|telefone|provedor_id|empresa_id|wa_id|texto/);
});

test('estado e plano: 0 objetos = ausente; 3 = presente (postcheck); parcial recusa com os grupos; privilégios de DDL só no ausente', () => {
  assert.equal(comum.lerEstado(estado()).m117, 'ausente');
  assert.equal(comum.lerEstado(estado(CHEIO)).m117, 'presente');
  const parcial = comum.lerEstado(estado({...CHEIO, indices: 0}));
  assert.equal(parcial.m117, 'parcial'); assert.deepEqual(parcial.divergencias, ['indices 0/1']);
  assert.throws(() => comum.lerEstado(estado(VAZIO, {dono_mensagens: 'sim'})), /ESTADO_ILEGIVEL dono_mensagens/);
  assert.throws(() => comum.lerEstado(estado({...VAZIO, tabelas: 3})), /ESTADO_ILEGIVEL tabelas/);
  assert.throws(() => comum.lerEstado(estado({...VAZIO, indices: -1})), /ESTADO_ILEGIVEL indices/);
  assert.throws(() => comum.lerEstado(estado(VAZIO, {indices_invalidos: null})), /ESTADO_ILEGIVEL indices_invalidos/);
  assert.throws(() => comum.lerEstado(estado(VAZIO, {indices_invalidos: [1]})), /ESTADO_ILEGIVEL indices_invalidos/);
  const p = (objetos, extra) => comum.planoEtapas(comum.lerEstado(estado(objetos, extra)));
  assert.deepEqual(p(VAZIO), PLANO_TUDO);
  assert.deepEqual(p(CHEIO), ['postcheck 117']);
  for (const [o, e, re] of [[{...VAZIO, indices: 1}, {}, / APLICACAO_PARCIAL_117 tabelas 0\/2$/], [{...VAZIO, tabelas: 1}, {}, / APLICACAO_PARCIAL_117 tabelas 1\/2, indices 0\/1$/],
    [VAZIO, {empresas: false}, /TABELA_AUSENTE empresas$/], [VAZIO, {mensagens: false}, /TABELA_AUSENTE whatsapp_atendimento_mensagens$/],
    [CHEIO, {status: false}, /TABELA_AUSENTE whatsapp_atendimento_status$/],
    [VAZIO, {usar_public: false}, /SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC$/], [CHEIO, {ler_mensagens: false}, /SEM_PRIVILEGIO_LEITURA SELECT_MENSAGENS$/],
    [VAZIO, {ler_empresas: false}, /SEM_PRIVILEGIO_LEITURA SELECT_EMPRESAS$/],
    [VAZIO, {dono_mensagens: false}, /SEM_PRIVILEGIO_117 DONO_MENSAGENS$/], [VAZIO, {referencias_empresas: false}, /SEM_PRIVILEGIO_117 REFERENCES_EMPRESAS$/],
    [VAZIO, {pode_criar: false}, /SEM_PRIVILEGIO_117 CREATE$/], [VAZIO, {plpgsql: false, dono_mensagens: false}, /SEM_PRIVILEGIO_117 DONO_MENSAGENS LINGUAGEM$/],
    [CHEIO, {ler_rodizio: false}, /SEM_PRIVILEGIO_117_PRESENTE SELECT_RODIZIO$/], [CHEIO, {ler_colisoes: false}, /SEM_PRIVILEGIO_117_PRESENTE SELECT_COLISOES$/],
    [CHEIO, {plpgsql: false}, /SEM_PRIVILEGIO_117_PRESENTE LINGUAGEM$/],
    [CHEIO, {ler_rodizio: false, ler_colisoes: false, plpgsql: false}, /SEM_PRIVILEGIO_117_PRESENTE SELECT_RODIZIO SELECT_COLISOES LINGUAGEM$/],
    [CHEIO, {indices_invalidos: ['whatsapp_atendimento_mensagens_ambiente_provedor_idx']}, /INDICE_INVALIDO_117 whatsapp_atendimento_mensagens_ambiente_provedor_idx$/],
    [CHEIO, {indices_invalidos: ['whatsapp_atendimento_rodizio_ordem_uq', 'whatsapp_atendimento_status_colisoes_pkey']}, /INDICE_INVALIDO_117 whatsapp_atendimento_rodizio_ordem_uq whatsapp_atendimento_status_colisoes_pkey$/]]) {
    assert.throws(() => p(o, e), re, JSON.stringify(e) + JSON.stringify(o));
  }
  assert.deepEqual(p(CHEIO, {dono_mensagens: false, referencias_empresas: false, pode_criar: false}), ['postcheck 117'], 'dono/REFERENCES/CREATE só com a 117 ausente');
  assert.deepEqual(p(VAZIO, {ler_rodizio: false, ler_colisoes: false}), PLANO_TUDO, 'SELECT nas tabelas novas só com a 117 presente');
});

test('situação do COMMIT: 40003 e classes 08/57/58/XX ou sem SQLSTATE = INDETERMINADO; demais SQLSTATE = desfeita', () => {
  for (const [e, esperado] of [
    // Transporte do Node: código de 5 letras não é SQLSTATE (P2 r1: EPIPE devolvia DESFEITA_PELO_SERVIDOR).
    [erroNode('EPIPE'), 'INDETERMINADO'], [Object.assign(new Error('x'), {code: 'EPIPE'}), 'INDETERMINADO'], [erroNode('EPERM', 'connect'), 'INDETERMINADO'],
    [erroNode('ECONNRESET', 'read'), 'INDETERMINADO'], [Object.assign(new Error('x'), {code: '23505'}), 'INDETERMINADO'],
    [Object.assign(new Error('x'), {code: '23505', severity: 'ERROR', syscall: 'write'}), 'INDETERMINADO'],[erroPg('40003'), 'INDETERMINADO'], [erroPg('57014'), 'INDETERMINADO'], [erroPg('08006'), 'INDETERMINADO'], [erroPg('XX000'), 'INDETERMINADO'],
    [new Error('Connection terminated unexpectedly'), 'INDETERMINADO'], [erroPg('23505'), 'DESFEITA_PELO_SERVIDOR'], [erroPg('40P01'), 'DESFEITA_PELO_SERVIDOR']]) {
    assert.equal(comum.commitNaFalha(e), esperado, String(e.code ?? e.message));
  }
});

test('trava de alvo de staging e identidade: serviço, ambiente, host, banco, porta, URL sem query; mensagem sem segredos', async () => {
  assert.equal(stg.alvo(ENV_STG).application_name, 'kidmais-migration-117-staging');
  assert.equal(stg.alvo({...ENV_STG, DATABASE_SSL: 'true'}).ssl.rejectUnauthorized, true);
  for (const [mudanca, erro] of [[{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg'}, /SERVICO_RECUSADO/],
    [{RENDER_SERVICE_ID: 'srv-dblbmf6gekts73fubo9g'}, /SERVICO_RECUSADO/], [{KIDMAIS_DEPLOY_ENV: 'production'}, /AMBIENTE_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace('dpg-daidko3m8hqs73ce4jt0-a', 'dpg-outro.render.com')}, /HOST_RECUSADO/], [{DATABASE_URL: URL_STG.replace('kidmais_staging_1z91', 'kidmais_manager')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace(':5432', ':5433')}, /PORTA_RECUSADA/], [{DATABASE_URL: URL_STG + '?sslmode=disable'}, /CONNECTION_QUERY_REJECTED/],
    [{DATABASE_SSL: 'talvez'}, /TLS_CONFIGURACAO_RECUSADA/], [{DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false'}, /TLS_CONFIGURACAO_RECUSADA/],
    [{DATABASE_URL: 'nao-e-url'}, /URL_RECUSADA/]]) {
    assert.throws(() => stg.alvo({...ENV_STG, ...mudanca}), (e) => erro.test(e.message) && !e.message.includes('SENHA_FALSA'), JSON.stringify(mudanca));
  }
  const outro = await stg.conferir({env: ENV_STG, Client: clienteFalso({identidade: {...ID_STG, db: 'outro_banco'}})});
  assert.equal(outro.resultado, 'FALHA'); assert.match(outro.mensagem, /IDENTIDADE_RECUSADA/); assert.ok(!JSON.stringify(outro).includes('SENHA_FALSA'));
  assert.equal(stg.DIR, '/opt/render/project/src/data/whatsapp-multiempresa-117-staging');
});

test('conferência: só leitura com search_path fixo, nada no disco; ausente = precheck; presente = postcheck; contagens', async () => {
  const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
  fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
  try {
    const Pronta = clienteFalso();
    const r = await stg.conferir({env: ENV_STG, Client: Pronta});
    assert.equal(r.resultado, 'PRONTA_PARA_APLICAR', JSON.stringify(r));
    assert.deepEqual(r.checks, {'precheck 117': 'PASS'}); assert.deepEqual(r.plano, PLANO_TUDO);
    assert.equal(r.estado.objetos, 0);
    assert.deepEqual(r.contagens, {mensagensPorAmbienteDirecao: {'staging:ENTRADA': 7, 'staging:SAIDA': 5}});
    assert.deepEqual(escritas(Pronta.log), []);
    const leituras = Pronta.log.filter(x => /^SELECT|^SET LOCAL search_path = public, pg_catalog;\nDO/.test(x.sql));
    assert.ok(leituras.length > 0 && leituras.every(x => x.ro), 'toda consulta dentro de READ ONLY');
    assert.ok(Pronta.log.some(x => x.ro && x.sql === CORPO_PRE)); assert.ok(!Pronta.log.some(x => x.sql === C117 || x.sql === comum.SQL_NOVAS));
    assert.ok(Pronta.log.filter(x => x.sql === 'SET LOCAL search_path = public, pg_catalog').length >= 3);
    const Aplicada = clienteFalso({aplicada: true});
    const j = await stg.conferir({env: ENV_STG, Client: Aplicada});
    assert.equal(j.resultado, 'JA_APLICADA_POSTCHECK_PASS', JSON.stringify(j));
    assert.deepEqual(j.checks, {'postcheck 117': 'PASS'}); assert.deepEqual(j.contagens.novas, {rodizio: 0, colisoes: 0});
    assert.ok(Aplicada.log.some(x => x.ro && x.sql === CORPO_POS) && !Aplicada.log.some(x => x.sql === CORPO_PRE));
    assert.deepEqual(escritas(Aplicada.log), []);
  } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
  assert.deepEqual(gravacoes, [], 'a conferência não grava arquivos');
  for (const [opcoes, motivo, sohCatalogo] of [[{objetos: {...VAZIO, tabelas: 2}}, /APLICACAO_PARCIAL_117 indices 0\/1$/, true],
    [{extra: {referencias_empresas: false}}, /SEM_PRIVILEGIO_117 REFERENCES_EMPRESAS/, true],
    [{falharEm: "'117 precheck: 060 ausente'", erro: erroPg('P0001', '117 precheck: 060 ausente')}, /117 precheck: 060 ausente/, false],
    [{aplicada: true, falharEm: "'117 postcheck: rodízio não está vazio'", erro: erroPg('P0001', '117 postcheck: rodízio não está vazio')}, /rodízio não está vazio/, false]]) {
    const C = clienteFalso(opcoes);
    const x = await stg.principal(['--conferir-117'], ENV_STG, {Client: C});
    assert.equal(x.codigo, 3, JSON.stringify(x)); assert.equal(x.saida.resultado, 'RECUSARIA'); assert.match(x.saida.motivo, motivo);
    if (sohCatalogo) assert.ok(!C.log.some(y => y.sql === CORPO_PRE || y.sql === comum.SQL_MENSAGENS), 'nada lido além do catálogo');
  }
  assert.equal((await stg.principal(['--conferir-117'], ENV_STG, {Client: clienteFalso()})).codigo, 0);
  await assert.rejects(stg.principal(['--conferir-117'], {...ENV_STG, RENDER_SERVICE_ID: 'srv-x'}, {Client: clienteFalso()}), /SERVICO_RECUSADO/);
});

test('aplicação: corpo sem COMMIT → preservação e postcheck NA transação → COMMIT → postcheck READ ONLY; contagens; marcador', async () => {
  await assert.rejects(stg.principal(['--aplicar-117-autorizado'], ENV_STG, {Client: clienteFalso()}), /BACKUP_OBRIGATORIO/);
  await assert.rejects(stg.principal(['--aplicar-117-autorizado', '--backup', 'x;rm'], ENV_STG, {Client: clienteFalso()}), /BACKUP_INVALIDO/);
  await assert.rejects(stg.principal(['--aplicar-116-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso()}), /ARGUMENTOS_RECUSADOS/);
  await assert.rejects(stg.principal(['--conferir-117', '--extra'], ENV_STG, {Client: clienteFalso()}), /ARGUMENTOS_RECUSADOS/);
  const dir = tmp();
  try {
    const C = clienteFalso();
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r));
    assert.deepEqual(r.etapas, PLANO_TUDO); assert.deepEqual(r.commits, {117: 'CONFIRMADO'}); assert.deepEqual(r.commitadas, ['117']);
    assert.equal(r.estadoAntes.m117, 'ausente'); assert.equal(r.estadoDepois.m117, 'presente');
    assert.deepEqual(r.contagensDepois.mensagensPorAmbienteDirecao, r.contagensAntes.mensagensPorAmbienteDirecao);
    assert.deepEqual(r.contagensDepois.novas, {rodizio: 0, colisoes: 0}); assert.equal(r.contagensAntes.novas, undefined);
    assert.deepEqual(escritas(C.log).map(x => x.sql), [C117], 'só o corpo (sem COMMIT) escreve');
    const i = C.log.findIndex(x => x.sql === C117), iCommit = C.log.findIndex((x, k) => k > i && x.sql === 'COMMIT');
    assert.ok(iCommit > i);
    const kPres = C.log.findIndex((x, n) => n > i && x.sql === comum.SQL_PRESERVACAO), kPos = C.log.findIndex((x, n) => n > i && x.sql === CORPO_POS);
    assert.ok(i < kPres && kPres < kPos && kPos < iCommit, 'preservação, depois postcheck, antes do COMMIT');
    for (const k of [kPres, kPos]) assert.ok(C.log[k].emTransacao && !C.log[k].ro, 'na transação da migration');
    assert.equal(C.log[i - 1].sql, 'ROLLBACK', 'o corpo abre a própria transação logo depois da última leitura');
    assert.ok(C.log.slice(0, i).some(x => x.ro && x.sql === CORPO_PRE), 'precheck em READ ONLY antes');
    assert.ok(C.log.slice(iCommit + 1).some(x => x.ro && x.sql === CORPO_POS), 'postcheck de novo em READ ONLY depois do COMMIT');
    assert.ok(!C.log.some(x => /^SET statement_timeout|^RESET/.test(x.sql)), 'prazos só os do SQL (SET LOCAL)');
    const m = JSON.parse(fs.readFileSync(r.marcador, 'utf8'));
    assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.backup, BACKUP); assert.deepEqual(m.commits, {117: 'CONFIRMADO'});
    assert.deepEqual(m.etapas.find(e => e.nome === 'migration 117').antesDoCommit, {preservacao: 'PASS', indices: 'PASS', 'postcheck 117': 'PASS'});
    const kInd = C.log.findIndex((x, n) => n > i && x.sql === comum.SQL_INDICES_INVALIDOS);
    assert.ok(kPres < kInd && kInd < kPos && C.log[kInd].emTransacao, 'índices conferidos na transação, entre a preservação e o postcheck');
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
      assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /PRESERVACAO_117 empresas=/);
      assert.deepEqual(r.commits, {117: 'NAO_COMMITADA'}); assert.deepEqual(r.commitadas, []);
      const i = C.log.findIndex(x => x.sql === C117);
      assert.ok(!C.log.slice(i).some(x => x.sql === 'COMMIT'), 'COMMIT nunca enviado'); assert.ok(C.log.slice(i).some(x => x.sql === 'ROLLBACK'));
      assert.ok(!C.log.slice(i).some(x => x.sql === CORPO_POS), 'postcheck nem chega a rodar');
      assert.equal(C.atual.aplicada, false, 'nada confirmado');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('situação do COMMIT na aplicação: corpo/verificação = NAO_COMMITADA; COMMIT 40003/08/57/sem resposta = INDETERMINADO; recusa = desfeita', async () => {
  const casos = [
    ['corpo (lock_timeout na FK para empresas)', {falharEm: 'CREATE TABLE whatsapp_atendimento_rodizio', erro: erroPg('55P03')}, 'NAO_COMMITADA'],
    ['corpo (lock_timeout no índice das mensagens)', {falharEm: 'CREATE INDEX IF NOT EXISTS whatsapp_atendimento_mensagens_ambiente_provedor_idx', erro: erroPg('55P03')}, 'NAO_COMMITADA'],
    ['corpo (conexão caiu)', {falharEm: 'CREATE TABLE whatsapp_atendimento_status_colisoes', erro: new Error('Connection terminated unexpectedly')}, 'NAO_COMMITADA'],
    ['corpo (statement_timeout do SQL)', {falharEm: 'CREATE INDEX IF NOT EXISTS', erro: erroPg('57014', 'canceling statement due to statement timeout')}, 'NAO_COMMITADA'],
    ['preservação (conexão caiu)', {falharEm: 'preservacao-117', erro: erroPg('08006')}, 'NAO_COMMITADA'],
    ['postcheck na transação', {falharEm: "'117 postcheck: definição divergente", erro: erroPg('P0001')}, 'NAO_COMMITADA'],
    ['COMMIT 40003', {falharCommit: {n: 1, erro: erroPg('40003')}}, 'INDETERMINADO'],
    ['COMMIT 08006', {falharCommit: {n: 1, erro: erroPg('08006')}}, 'INDETERMINADO'],
    ['COMMIT 57014', {falharCommit: {n: 1, erro: erroPg('57014')}}, 'INDETERMINADO'],
    ['COMMIT sem resposta', {falharCommit: {n: 1, erro: new Error('Connection terminated unexpectedly')}}, 'INDETERMINADO'],
    ['COMMIT com EPIPE (transporte)', {falharCommit: {n: 1, erro: erroNode('EPIPE')}}, 'INDETERMINADO'],
    ['índice inválido na transação', {invalidosNaTransacao: ['whatsapp_atendimento_rodizio_ordem_uq']}, 'NAO_COMMITADA'],
    ['COMMIT recusado (23514)', {falharCommit: {n: 1, erro: erroPg('23514')}}, 'DESFEITA_PELO_SERVIDOR'],
    ['COMMIT respondido como ROLLBACK', {falharCommit: {n: 1, rollback: true}}, 'DESFEITA_PELO_SERVIDOR'],
  ];
  for (const [rotulo, opcoes, commit] of casos) {
    const dir = tmp();
    try {
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: clienteFalso(opcoes), disco: semDisco});
      assert.equal(r.resultado, 'FALHA', rotulo + JSON.stringify(r)); assert.deepEqual(r.commits, {117: commit}, rotulo);
      assert.equal(r.falha.etapa, 'migration 117', rotulo); assert.match(r.reconciliar, /--conferir-117/);
      const m = JSON.parse(fs.readFileSync(r.marcador, 'utf8'));
      assert.equal(m.situacao, 'FALHA'); assert.deepEqual(m.commits, {117: commit}, rotulo + ' (marcador)');
      await assert.rejects(stg.principal(['--aplicar-117-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso(), dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('retomada autorizada: COMMIT indeterminado que confirmou; marcador renomeado → nova execução só roda o postcheck', async () => {
  const dir = tmp();
  try {
    const r1 = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: clienteFalso({falharCommit: {n: 1, erro: erroPg('08006')}}), disco: semDisco});
    assert.deepEqual(r1.commits, {117: 'INDETERMINADO'});
    fs.renameSync(path.join(dir, comum.MARCADOR), path.join(dir, 'migration-117.2026-11-04T22-00.json'));
    const C2 = clienteFalso({aplicada: true, extra: {dono_mensagens: false, pode_criar: false, referencias_empresas: false}});
    const r2 = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C2, disco: semDisco});
    assert.equal(r2.resultado, 'JA_APLICADA_POSTCHECK_PASS', JSON.stringify(r2)); assert.deepEqual(r2.etapas, ['postcheck 117']); assert.deepEqual(r2.commits, {});
    assert.deepEqual(escritas(C2.log), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8')).tentativasAnteriores, ['migration-117.2026-11-04T22-00.json']);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('estado que não completa depois do COMMIT, deriva depois do postcheck, recusas antes de escrever e disco ausente', async () => {
  for (const [opcoes, motivo, commits] of [[{naoCompleta: true}, /ESTADO_DEPOIS_117/, {117: 'CONFIRMADO'}],
    [{aplicada: true, objetosDepoisDe: {n: 1, objetos: {...CHEIO, indices: 0}}}, /ESTADO_FINAL_117/, {}],
    [{objetos: {...VAZIO, indices: 1}}, /APLICACAO_PARCIAL_117 tabelas 0\/2$/, {}], [{extra: {pode_criar: false}}, /SEM_PRIVILEGIO_117 CREATE/, {}],
    [{extra: {dono_mensagens: false}}, /SEM_PRIVILEGIO_117 DONO_MENSAGENS/, {}]]) {
    const dir = tmp();
    try {
      const C = clienteFalso(opcoes);
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'FALHA', JSON.stringify(r)); assert.match(r.falha.mensagem, motivo); assert.deepEqual(r.commits, commits);
      if (!commits[117]) assert.deepEqual(escritas(C.log), [], 'recusa antes de qualquer escrita');
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
    const x = await stg.principal(['--aplicar-117-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso({falharEm: 'CREATE TABLE whatsapp_atendimento_status_colisoes'}), dir: dir2, disco: semDisco});
    assert.equal(x.codigo, 2); assert.equal(x.saida.resultado, 'FALHA');
  } finally { fs.rmSync(dir2, {recursive: true, force: true}); }
});

test('SQL revisado divergente: plano, conferência e aplicação recusam antes de conectar ou de ler o banco', async () => {
  const outra = fs.mkdtempSync(path.join(os.tmpdir(), 'raiz-117-'));
  try {
    for (const [, a] of comum.ETAPAS) { fs.mkdirSync(path.dirname(path.join(outra, a)), {recursive: true}); fs.copyFileSync(path.join(raiz, a), path.join(outra, a)); }
    fs.appendFileSync(path.join(outra, comum.ETAPAS[1][1]), '\n-- alterado\n');
    assert.throws(() => stg.plano({raiz: outra}), /ARQUIVO_DIVERGENTE database\/migrations\/20261104_117/);
    const dir = tmp();
    try {
      await assert.rejects(stg.executar({env: ENV_STG, backup: BACKUP, dir, raiz: outra, Client: clienteFalso(), disco: semDisco}), /ARQUIVO_DIVERGENTE/);
      assert.deepEqual(fs.readdirSync(dir), [], 'nenhum marcador');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    fs.copyFileSync(path.join(raiz, comum.ETAPAS[1][1]), path.join(outra, comum.ETAPAS[1][1]));
    fs.appendFileSync(path.join(outra, comum.ETAPAS[0][1]), '\n-- alterado\n');
    const C = clienteFalso();
    const r = await stg.conferir({env: ENV_STG, raiz: outra, Client: C});
    assert.equal(r.resultado, 'RECUSARIA', JSON.stringify(r)); assert.match(r.motivo, /ARQUIVO_DIVERGENTE database\/checks\/20261104_117_precheck/);
    assert.ok(!C.log.some(x => x.sql === CORPO_PRE), 'precheck divergente nunca enviado');
  } finally { fs.rmSync(outra, {recursive: true, force: true}); }
});

test('plano sem conexão: 3 SQL com sha, prova no alvo, prazos do SQL, ordem com PITR e autorização, paradas; nunca o down nem a chave', async () => {
  const {codigo, saida} = await stg.principal([], {});
  assert.equal(codigo, 0); assert.equal(saida.conecta, false); assert.equal(saida.ambiente, 'staging');
  assert.deepEqual(saida.arquivos.map(a => a.sha256), comum.ETAPAS.map(e => e[2]));
  assert.match(saida.provaNoAlvo, /preservação/); assert.match(saida.provaNoAlvo, /antes do COMMIT/);
  assert.match(saida.prazos, /lock_timeout 5 s e statement_timeout 60 s do próprio SQL/);
  assert.ok(saida.ordem.some(o => /PITR/.test(o)) && saida.ordem.some(o => /autorização de Felipe para a 117/.test(o)) && saida.ordem.some(o => /imediatamente antes/.test(o)));
  assert.ok(saida.ordem.some(o => /fora do minuto do cron/.test(o)) && saida.ordem.some(o => /modo PILOTO, chave desligada/.test(o)));
  assert.ok(saida.preRequisitos.some(p => /DONO de whatsapp_atendimento_mensagens, com REFERENCES e SELECT em empresas/.test(p)));
  assert.ok(saida.preRequisitos.some(p => /WHATSAPP_ATENDIMENTO_MULTIEMPRESA DESLIGADA .*recusa antes do marcador/.test(p)) && saida.preRequisitos.some(p => /#330/.test(p)));
  assert.ok(saida.paradas.some(p => /nunca apagar/.test(p)) && saida.paradas.some(p => /INDETERMINADO/.test(p)));
  assert.ok(saida.recuperacao.some(r => /critério de corte/.test(r)) && saida.recuperacao.some(r => /PITR/.test(r)));
  assert.ok(saida.nuncaExecuta.includes('down 117') && saida.nuncaExecuta.includes('ligar WHATSAPP_ATENDIMENTO_MULTIEMPRESA'));
  assert.ok(!saida.arquivos.some(a => a.arquivo.includes('rollback')));
  assert.equal(JSON.stringify(saida).includes('DATABASE_URL'), false);
});

test('P1 (Astra r1): chave MULTI ligada ou inválida — aplicação recusa antes do marcador e de conectar; conferência informa e recusa', async () => {
  assert.equal(comum.estadoChave({}), 'DESLIGADA'); assert.equal(comum.estadoChave({WHATSAPP_ATENDIMENTO_MULTIEMPRESA: 'false'}), 'DESLIGADA');
  assert.equal(comum.estadoChave({WHATSAPP_ATENDIMENTO_MULTIEMPRESA: 'true'}), 'LIGADA');
  for (const v of ['TRUE', '1', ' true', '']) assert.equal(comum.estadoChave({WHATSAPP_ATENDIMENTO_MULTIEMPRESA: v}), 'INVALIDA', JSON.stringify(v));
  for (const [valor, chave] of [['true', 'LIGADA'], ['TRUE', 'INVALIDA']]) {
    const env = {...ENV_STG, WHATSAPP_ATENDIMENTO_MULTIEMPRESA: valor};
    for (const aplicada of [false, true]) {
      const C = clienteFalso({aplicada});
      const x = await stg.principal(['--conferir-117'], env, {Client: C});
      assert.equal(x.codigo, 3, JSON.stringify(x)); assert.equal(x.saida.resultado, 'RECUSARIA'); assert.equal(x.saida.chave, chave);
      assert.match(x.saida.motivo, new RegExp('CHAVE_MULTIEMPRESA_NAO_DESLIGADA ' + chave + '$'));
      assert.ok(x.saida.estado, 'estado informado mesmo recusando'); assert.ok(!C.log.some(y => y.sql === CORPO_PRE || y.sql === CORPO_POS));
      assert.deepEqual(escritas(C.log), []);
    }
    const dir = tmp();
    try {
      const C = clienteFalso();
      await assert.rejects(stg.principal(['--aplicar-117-autorizado', '--backup', BACKUP], env, {Client: C, dir, disco: semDisco}), new RegExp('CHAVE_MULTIEMPRESA_NAO_DESLIGADA ' + chave + '$'));
      assert.deepEqual(fs.readdirSync(dir), [], 'nenhum marcador'); assert.deepEqual(C.log, [], 'nada enviado ao banco');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
  // Defesa em profundidade: o núcleo também recusa sem a chave informada.
  await assert.rejects(comum.aplicarNoCliente(new (clienteFalso())(), {raiz, sqlIdentidade: stg.SQL_IDENTIDADE, identidade: l => l}), /CHAVE_MULTIEMPRESA_NAO_DESLIGADA undefined/);
  const ok = await stg.conferir({env: {...ENV_STG, WHATSAPP_ATENDIMENTO_MULTIEMPRESA: 'false'}, Client: clienteFalso()});
  assert.equal(ok.resultado, 'PRONTA_PARA_APLICAR'); assert.equal(ok.chave, 'DESLIGADA');
});

test('P3 (Astra r1): sem USAGE em public, recusa nominal antes de qualquer to_regclass; aplicação sem marcador de commit', async () => {
  const C = clienteFalso({semUsagePublic: true});
  const x = await stg.principal(['--conferir-117'], ENV_STG, {Client: C});
  assert.equal(x.codigo, 3, JSON.stringify(x)); assert.match(x.saida.motivo, /^SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC$/);
  assert.ok(!C.log.some(y => y.sql === comum.SQL_ESTADO), 'o estado (to_regclass qualificado) nunca é enviado');
  const dir = tmp();
  try {
    const C2 = clienteFalso({semUsagePublic: true});
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C2, disco: semDisco});
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /^SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC$/); assert.deepEqual(r.commits, {});
    assert.ok(!C2.log.some(y => y.sql === comum.SQL_ESTADO)); assert.deepEqual(escritas(C2.log), []);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('P2 (Astra r1): índice da 117 inválido com a definição esperada — conferência e aplicação recusam pelo nome, sem escrever', async () => {
  const extra = {indices_invalidos: ['whatsapp_atendimento_mensagens_ambiente_provedor_idx']};
  const C = clienteFalso({aplicada: true, extra});
  const x = await stg.principal(['--conferir-117'], ENV_STG, {Client: C});
  assert.equal(x.codigo, 3); assert.match(x.saida.motivo, /^INDICE_INVALIDO_117 whatsapp_atendimento_mensagens_ambiente_provedor_idx$/);
  assert.deepEqual(x.saida.estado.indices_invalidos, extra.indices_invalidos); assert.ok(!C.log.some(y => y.sql === CORPO_POS));
  const dir = tmp();
  try {
    const C2 = clienteFalso({aplicada: true, extra});
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C2, disco: semDisco});
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /INDICE_INVALIDO_117/); assert.deepEqual(escritas(C2.log), []);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
