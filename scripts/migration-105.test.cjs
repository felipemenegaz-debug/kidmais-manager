/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 105 (canal MCP por assinatura, staging) com cliente simulado que só CONFIRMA no COMMIT e descarta no
// ROLLBACK: hashes, estado só pelo catálogo, privilégios um a um, trava de alvo, conferência só leitura com search_path
// fixo, migration sem o COMMIT final com postcheck e integridade na transação, situação do COMMIT (NAO_COMMITADA /
// CONFIRMADO / DESFEITA_PELO_SERVIDOR / INDETERMINADO, inclusive 40003), marcador anti-repetição e retomada pelo marcador
// renomeado; conferência pela DEFINIÇÃO (integridade, definições e relações numa fotografia) no CONFERIR, na guarda de
// reaplicação, antes e depois do COMMIT; diagnóstico em vocabulário fechado. Sem rede nem banco (a prova real é lib/integracoes/oauth/aplicador-105.postgres.test.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const comum = require('./migration-105-comum.cjs');
const {lerRevisado} = require('./migration-092-094-comum.cjs');
const stg = require('./migration-105-staging.cjs');
const defs = require('./migration-105-definicoes.cjs');
const rel = require('./migration-105-relacoes.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_STG = 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91';
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false', DATABASE_URL: URL_STG});
const ID_STG = {db: 'kidmais_staging_1z91', tls: false, servidor_privado: true};
const BACKUP = 'PITR staging 27/10 21:00Z';
const ler = nome => { const [, a, h] = comum.ETAPAS.find(e => e[0] === nome); return lerRevisado(raiz, a, h); };
const DEF105 = lerRevisado(raiz, comum.DEFINICOES_105[1], comum.DEFINICOES_105[2]);
const M105 = ler('migration 105'), P105 = ler('postcheck 105'), I105 = ler('integridade 105'), PRE105 = ler('precheck 105');
const C105 = comum.semCommitFinal(M105, 'm105');
const erroPg = (code, msg = 'erro simulado') => Object.assign(new Error(msg), {code});
const COMPLETA = {m105_tabelas: 6, m105_funcao: 1, m105_gatilho: 1};
const estado = (extra = {}) => ({versao_pg: 180006, d105: true, m105_tabelas: 0, m105_funcao: 0, m105_gatilho: 0,
  usar_public: true, pode_criar: true, referencias_105: true, plpgsql: true, gerar_uuid: true, ler_105: false, papel_trocado: true, ...extra});
const CONTAGENS = {clientes: 0, concessoes: 0, concessoes_ativas: 0, tokens: 0, auditoria: 0};
const PLANO_TUDO = ['precheck 105', 'migration 105', 'integridade 105'];
const COMPLETA_PASS = Object.freeze({'integridade 105': 'PASS', 'definicoes 105': 'PASS', 'relacoes 105': 'PASS'});
/** O inventário de definições da 105 íntegra (1ª alternativa de cada chave) e as relações do PG 18.6. */
const linhasDef = () => Object.entries(defs.ESPERADO).map(([chave, v]) => ({chave, definicao: [v].flat()[0]})).sort((a, b) => (a.chave < b.chave ? -1 : 1));
const relOk = () => ({versao_pg: 180006, ...rel.REFERENCIAS});
const LF = String.fromCharCode(10);
const mudaDef = (chave, f) => rs => rs.map(l => (l.chave === chave ? {...l, definicao: f(l.definicao)} : l));
const mudaRel = (tabela, f) => r => ({...r, [tabela]: f(r[tabela].split(LF)).join(LF)});
const MARCADOR = 'MARCADOR_PRIVADO_SINTETICO';
const MARCADOR_RE = /MARCADOR_PRIVADO_SINTETICO/;
/** Erro externo com o marcador em todos os campos de texto que o pg preenche. */
const erroMarcado = code => Object.assign(new Error(MARCADOR + ' mensagem'), {code, detail: MARCADOR, hint: MARCADOR, where: MARCADOR,
  table: MARCADOR, constraint: MARCADOR, schema: MARCADOR});
const MUTANTES_DEF = Object.freeze({
  'RLS ligada': mudaDef('tabela:mcp_auditoria', d => d.replace('rls=false', 'rls=true')),
  'dono diferente': mudaDef('tabela:mcp_oauth_tokens', d => d.replace('dono_da_aplicacao=true', 'dono_da_aplicacao=false')),
  'chave desconhecida (nome do banco)': rs => [...rs, {chave: 'indice:' + MARCADOR, definicao: MARCADOR}],
  'chave faltando': rs => rs.slice(1),
});
const NN_CODIGOS = 'restricao public.mcp_oauth_codigos mcp_oauth_codigos_concessao_id_not_null n t f f t f true NOT NULL concessao_id';
const MUTANTES_REL = Object.freeze({
  'NOT NULL NOT VALID (PG 18)': [mudaRel('mcp_oauth_codigos', ls => ls.map(l => (l === NN_CODIGOS ? l.replace(' n t f f ', ' n f f f ') : l))), 'mcp_oauth_codigos FALTA restricao'],
  'FK de entrada vinda de fora da 105': [mudaRel('mcp_oauth_tokens', ls => [...ls,
    'restricao public.tabela_externa tabela_externa_token_fkey f t f f t t true FOREIGN KEY (token_id) REFERENCES public.mcp_oauth_tokens(id)']), 'mcp_oauth_tokens SOBRA restricao'],
  'política criada': [mudaRel('mcp_oauth_clientes', ls => ls.map(l => (l === 'politicas 0' ? 'politicas 1' : l))), 'mcp_oauth_clientes FALTA politicas'],
  'LF no nome de FK de entrada externa': [mudaRel('mcp_oauth_tokens', ls => [...ls,
    'restricao public.externa nome_fk', MARCADOR + ' restante f t f f t t true FOREIGN KEY (id) REFERENCES public.mcp_oauth_tokens(id)']), 'mcp_oauth_tokens SOBRA ILEGIVEL'],
  'PG 17 (sem referência)': [r => ({...r, versao_pg: 170004}), 'SEM_REFERENCIA_PG 17'],
});

/**
 * Cliente simulado transacional: o corpo da migration (sem COMMIT) deixa o efeito PENDENTE; 'COMMIT' confirma e
 * 'ROLLBACK' descarta. SQL_ESTADO devolve o estado CONFIRMADO. Opções: falharEm (trecho que lança `erro`),
 * falharCommit ({n, erro} ou {n, rollback: true}), integra / integraNaTransacao (integra_105), naoCompleta, defs / defsNaTransacao
 * (linhas do SQL de definições), rel / relNaTransacao (linha de SQL_RELACOES).
 */
function clienteFalso({inicial = estado(), identidade = ID_STG, falharEm, erro, falharCommit, integra = true, integraNaTransacao = true, naoCompleta,
  defs = linhasDef(), defsNaTransacao = defs, rel: relacoes = relOk(), relNaTransacao = relacoes} = {}) {
  const log = []; let ro = false, pendente = null, commits = 0;
  const atual = {...inicial};
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql) {
      if (sql === comum.BEGIN_LEITURA) ro = true;
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
      if (sql.includes('AS concessoes_ativas')) return {rows: [{...CONTAGENS}]};
      if (sql === I105) return {rows: [{integra_105: pendente ? integraNaTransacao : integra}]};
      if (sql === DEF105) return {rows: pendente ? defsNaTransacao : defs};
      if (sql === rel.SQL_RELACOES) return {rows: [pendente ? relNaTransacao : relacoes]};
      if (sql === C105) { assert.equal(ro, false, 'migration nunca em READ ONLY'); pendente = {aplicar: () => { if (!naoCompleta) Object.assign(atual, COMPLETA, {ler_105: true}); }}; }
      assert.notEqual(sql, M105, 'o arquivo COM o COMMIT final nunca é enviado');
      return {rows: []};
    }
  };
  C.log = log; C.atual = atual;
  return C;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-105-'));
const semDisco = () => {};
const escritas = log => log.filter(x => !x.ro && !/^(BEGIN TRANSACTION|ROLLBACK|COMMIT|SET LOCAL)/.test(x.sql) && !x.emTransacao);

test('hashes dos 4 SQL; a migration é UMA transação terminando em COMMIT, enviada sem ele; integridade confere o corpo da função', () => {
  for (const [, arquivo, hash] of comum.ETAPAS) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), hash, arquivo);
  }
  assert.deepEqual(comum.ETAPAS.map(e => e[0]), ['precheck 105', 'migration 105', 'postcheck 105', 'integridade 105']);
  assert.equal(createHash('sha256').update(DEF105, 'utf8').digest('hex'), comum.DEFINICOES_105[2], 'definições');
  assert.deepEqual(comum.DEFINICOES_105.slice(1), [defs.SQL_ARQUIVO, require('./migration-105-production-nucleo.cjs').ETAPAS.at(-1)[2]], 'o mesmo SQL de definições do aplicador de produção');
  assert.deepEqual(comum.ARQUIVOS, [...comum.ETAPAS, comum.DEFINICOES_105]);
  assert.match(M105, /SET LOCAL lock_timeout = '5s'/); assert.match(M105, /SET LOCAL search_path = public, pg_catalog;/);
  assert.equal(C105 + 'COMMIT;\n', M105, 'só o COMMIT final sai'); assert.doesNotMatch(C105, /^COMMIT;$/m); assert.match(C105, /^BEGIN;$/m);
  assert.throws(() => comum.semCommitFinal(M105 + 'COMMIT;\n', 'x'), /TRANSACAO_INESPERADA/);
  assert.throws(() => comum.semCommitFinal(C105, 'x'), /TRANSACAO_INESPERADA/);
  assert.throws(() => comum.semCommitFinal(M105.replace('BEGIN;\n', ''), 'x'), /TRANSACAO_INESPERADA/);
  // O sha256 do corpo da função na integridade é o do texto entre $f$ da própria migration (nada copiado à mão).
  const i = M105.indexOf('AS $f$') + 'AS $f$'.length, corpo = M105.slice(i, M105.indexOf('$f$;', i));
  assert.ok(I105.includes(createHash('sha256').update(corpo, 'utf8').digest('hex')), 'sha do prosrc na integridade');
  // Integridade só lê o catálogo e devolve integra_105; o postcheck exige tabelas vazias (por isso não é repetido depois).
  assert.match(I105, /AS integra_105;\s*$/); assert.doesNotMatch(I105.replace(/--.*$/gm, ''), /FROM public\.mcp_/);
  assert.match(P105, /deveriam estar vazias/);
  for (const t of comum.TABELAS_105) { assert.ok(I105.includes(`'${t}'`), t); assert.ok(M105.includes(`CREATE TABLE public.${t} (`), t); }
  for (const idx of M105.matchAll(/CREATE (?:UNIQUE )?INDEX (\S+) ON/g)) assert.ok(I105.includes(`'${idx[1]}'`), idx[1]);
  assert.equal([...M105.matchAll(/CREATE (?:UNIQUE )?INDEX /g)].length, 11, '11 índices nomeados na migration e na integridade');
  // Contagens da integridade (colunas, CHECK, PK, UNIQUE, FK por tabela) derivadas do TEXTO da migration: mudar a
  // migration sem ajustar a integridade quebra aqui (a prova no catálogo real é aplicador-105.postgres.test.ts).
  for (const b of M105.matchAll(/CREATE TABLE public\.(\w+) \(\n([\s\S]*?)\n\);/g)) {
    const linhas = b[2].split('\n').filter(l => l.trim() && !l.trim().startsWith('--'));
    const n = re => (b[2].match(re) ?? []).length;
    const esperado = `('${b[1]}', ${linhas.filter(l => /^ {2}[a-z_]+ /.test(l)).length}, ${n(/CHECK \(/g)}, ${n(/PRIMARY KEY/g)}, ${n(/\bUNIQUE\b/g)}, ${n(/REFERENCES/g)})`;
    assert.ok(I105.includes(esperado), 'integridade conta ' + esperado);
  }
  assert.throws(() => lerRevisado(raiz, comum.ETAPAS[1][1], 'f'.repeat(64)), /ARQUIVO_DIVERGENTE/);
});

test('estado só lê catálogo e privilégios (nenhuma tabela de dados); privilégios um a um', () => {
  const sem = comum.SQL_ESTADO.replace(/'[^']*'/g, "''");
  assert.doesNotMatch(sem, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|TRUNCATE)\b/);
  const fontes = [...comum.SQL_ESTADO.matchAll(/\bFROM\s+([a-z_.]+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(fontes)].sort(), ['pg_class', 'pg_proc', 'pg_trigger'], 'só catálogo');
  assert.match(comum.SQL_ESTADO, /has_schema_privilege\(current_user, 'public', 'USAGE'\) AS usar_public/);
  assert.match(comum.SQL_ESTADO, /has_schema_privilege\(current_user, 'public', 'CREATE'\) AS pode_criar/);
  const priv = (t, p) => `has_table_privilege(current_user, oid, '${p}') FROM pg_class WHERE oid = to_regclass('public.${t}')`;
  for (const t of ['usuarios_administrativos', 'empresas']) assert.ok(comum.SQL_ESTADO.includes(priv(t, 'REFERENCES')), t);
  for (const t of comum.TABELAS_105) assert.ok(comum.SQL_ESTADO.includes(priv(t, 'SELECT')), t);
  assert.match(comum.SQL_ESTADO, /has_language_privilege\(current_user, 'plpgsql', 'USAGE'\)/);
  assert.match(comum.SQL_ESTADO, /has_function_privilege\(current_user, to_regprocedure\('gen_random_uuid\(\)'\), 'EXECUTE'\)/);
});

test('estado e plano: ausente/completa/parcial; recusas nomeadas e privilégios só do caso pendente', () => {
  assert.equal(comum.lerEstado(estado()).m105, 'ausente');
  assert.equal(comum.lerEstado(estado(COMPLETA)).m105, 'completa');
  for (const p of [{m105_tabelas: 6}, {m105_tabelas: 1}, {m105_funcao: 1}, {m105_gatilho: 1}, {...COMPLETA, m105_tabelas: 5}, {...COMPLETA, m105_gatilho: 0}]) {
    assert.equal(comum.lerEstado(estado(p)).m105, 'parcial', JSON.stringify(p));
  }
  assert.throws(() => comum.lerEstado(estado({plpgsql: 'sim'})), /ESTADO_ILEGIVEL plpgsql/);
  assert.throws(() => comum.lerEstado(estado({m105_tabelas: -1})), /ESTADO_ILEGIVEL m105_tabelas/);
  const p = e => comum.planoEtapas(comum.lerEstado(estado(e)));
  assert.deepEqual(p({}), PLANO_TUDO);
  assert.deepEqual(p({...COMPLETA, ler_105: true}), ['integridade 105']);
  for (const [e, re] of [[{m105_tabelas: 3}, /APLICACAO_PARCIAL_105/], [{d105: false}, /DEPENDENCIA_AUSENTE_105/], [{usar_public: false}, /SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC$/],
    [{pode_criar: false}, /SEM_PRIVILEGIO_105 CREATE$/], [{referencias_105: false}, /SEM_PRIVILEGIO_105 REFERENCES$/], [{plpgsql: false, gerar_uuid: false}, /SEM_PRIVILEGIO_105 LINGUAGEM GEN_RANDOM_UUID$/],
    [{...COMPLETA}, /SEM_PRIVILEGIO_105 SELECT_TABELAS$/]]) {
    assert.throws(() => p(e), re, JSON.stringify(e));
  }
  assert.deepEqual(p({...COMPLETA, ler_105: true, pode_criar: false, referencias_105: false, d105: false}), ['integridade 105'], 'CREATE/REFERENCES/dependências só com a 105 pendente');
});

test('situação do COMMIT: 40003 e classes 08/57/58/XX ou sem SQLSTATE = INDETERMINADO; demais SQLSTATE = desfeita', () => {
  for (const [e, esperado] of [[erroPg('40003'), 'INDETERMINADO'], [erroPg('57014'), 'INDETERMINADO'], [erroPg('08006'), 'INDETERMINADO'], [erroPg('XX000'), 'INDETERMINADO'],
    [new Error('Connection terminated unexpectedly'), 'INDETERMINADO'], [erroPg('23503'), 'DESFEITA_PELO_SERVIDOR'], [erroPg('40P01'), 'DESFEITA_PELO_SERVIDOR']]) {
    assert.equal(comum.commitNaFalha(e), esperado, String(e.code ?? e.message));
  }
});

test('trava de alvo de staging e identidade: serviço, ambiente, host, banco, porta, URL sem query; mensagem sem segredos', async () => {
  assert.equal(stg.alvo(ENV_STG).application_name, 'kidmais-migration-105-staging');
  for (const [mudanca, erro] of [[{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg'}, /SERVICO_RECUSADO/], [{KIDMAIS_DEPLOY_ENV: 'production'}, /AMBIENTE_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace('dpg-daidko3m8hqs73ce4jt0-a', 'dpg-outro.render.com')}, /HOST_RECUSADO/], [{DATABASE_URL: URL_STG.replace('kidmais_staging_1z91', 'kidmais_manager')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace(':5432', ':5433')}, /PORTA_RECUSADA/], [{DATABASE_URL: URL_STG + '?sslmode=disable'}, /CONNECTION_QUERY_REJECTED/],
    [{DATABASE_SSL: 'talvez'}, /TLS_CONFIGURACAO_RECUSADA/]]) {
    assert.throws(() => stg.alvo({...ENV_STG, ...mudanca}), (e) => erro.test(e.message) && !e.message.includes('SENHA_FALSA'));
  }
  const outro = await stg.conferir({env: ENV_STG, Client: clienteFalso({identidade: {...ID_STG, db: 'outro_banco'}})});
  assert.equal(outro.resultado, 'FALHA'); assert.ok(!JSON.stringify(outro).includes('SENHA_FALSA'));
  assert.equal(outro.mensagem, 'IDENTIDADE_RECUSADA BANCO', 'causa em vocabulário fechado');
  const semTls = await stg.conferir({env: ENV_STG, Client: clienteFalso({identidade: {...ID_STG, tls: true}})});
  assert.equal(semTls.mensagem, 'IDENTIDADE_RECUSADA TLS');
  assert.equal(stg.DIR, '/opt/render/project/src/data/mcp-105-staging');
});

test('conferência: só leitura com lock_timeout e search_path fixo, nada no disco; ausente = precheck; completa = integridade + contagens', async () => {
  const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
  fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
  try {
    const Pronta = clienteFalso();
    const r = await stg.conferir({env: ENV_STG, Client: Pronta});
    assert.equal(r.resultado, 'PRONTA_PARA_APLICAR', JSON.stringify(r));
    assert.deepEqual(r.checks, {'precheck 105': 'PASS'}); assert.deepEqual(r.plano, PLANO_TUDO); assert.equal(r.contagens, undefined, 'sem tabelas, sem contagem');
    assert.deepEqual(escritas(Pronta.log), []);
    const leituras = Pronta.log.filter(x => /^SELECT|^DO|^--/.test(x.sql));
    assert.ok(leituras.length > 0 && leituras.every(x => x.ro), 'toda consulta dentro de READ ONLY');
    assert.equal(Pronta.log.filter(x => x.sql === 'SET LOCAL search_path = public, pg_catalog').length, leituras.length, 'search_path fixo em toda leitura');
    assert.ok(Pronta.log.some(x => x.ro && x.sql === PRE105)); assert.ok(!Pronta.log.some(x => x.sql === C105));
    const Aplicada = clienteFalso({inicial: estado({...COMPLETA, ler_105: true})});
    const j = await stg.conferir({env: ENV_STG, Client: Aplicada});
    assert.equal(j.resultado, 'JA_APLICADA_INTEGRIDADE_PASS', JSON.stringify(j));
    assert.deepEqual(j.checks, COMPLETA_PASS); assert.deepEqual(j.contagens, CONTAGENS);
    assert.deepEqual(j.detalhes.divergencias, []); assert.deepEqual(j.detalhes.divergenciasRelacoes, []);
    assert.ok(!Aplicada.log.some(x => x.sql === P105), 'o postcheck (tabelas vazias) não é usado numa 105 já aplicada');
    assert.deepEqual(escritas(Aplicada.log), []);
  } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
  assert.deepEqual(gravacoes, [], 'a conferência não grava arquivos');
  for (const [opcoes, motivo] of [[{inicial: estado({m105_tabelas: 4})}, /APLICACAO_PARCIAL_105/], [{inicial: estado({referencias_105: false})}, /SEM_PRIVILEGIO_105 REFERENCES/],
    [{inicial: estado({d105: false})}, /DEPENDENCIA_AUSENTE_105/], [{inicial: estado({...COMPLETA, ler_105: true}), integra: false}, /INTEGRIDADE_105 false/],
    [{falharEm: '105 precheck'}, /^ERRO_SERVIDOR 55P03$/]]) {
    const C = clienteFalso(opcoes);
    const x = await stg.principal(['--conferir-105'], ENV_STG, {Client: C});
    assert.equal(x.codigo, 3, JSON.stringify(x)); assert.equal(x.saida.resultado, 'RECUSARIA'); assert.match(x.saida.motivo, motivo);
    if (/PARCIAL|PRIVILEGIO|DEPENDENCIA/.test(String(motivo))) assert.ok(!C.log.some(x => x.sql === PRE105 || x.sql.includes('AS concessoes_ativas')), 'nada lido além do catálogo');
  }
  assert.equal((await stg.principal(['--conferir-105'], ENV_STG, {Client: clienteFalso()})).codigo, 0);
  await assert.rejects(stg.principal(['--conferir-105'], {...ENV_STG, RENDER_SERVICE_ID: 'srv-x'}, {Client: clienteFalso()}), /SERVICO_RECUSADO/);
});

test('aplicação: corpo sem COMMIT → postcheck e integridade NA transação → COMMIT → integridade READ ONLY; marcador', async () => {
  await assert.rejects(stg.principal(['--aplicar-105-autorizado'], ENV_STG, {Client: clienteFalso()}), /BACKUP_OBRIGATORIO/);
  await assert.rejects(stg.principal(['--aplicar-105-autorizado', '--backup', 'x;rm'], ENV_STG, {Client: clienteFalso()}), /BACKUP_INVALIDO/);
  await assert.rejects(stg.principal(['--aplicar-102-103-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso()}), /ARGUMENTOS_RECUSADOS/);
  const dir = tmp();
  try {
    const C = clienteFalso();
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r));
    assert.deepEqual(r.etapas, PLANO_TUDO); assert.deepEqual(r.commits, {105: 'CONFIRMADO'}); assert.deepEqual(r.commitadas, ['105']);
    assert.equal(r.estadoDepois.m105, 'completa'); assert.deepEqual(r.contagensDepois, CONTAGENS);
    assert.deepEqual(escritas(C.log).map(x => x.sql), [C105], 'só o corpo (sem COMMIT) escreve');
    const i = C.log.findIndex(x => x.sql === C105), iCommit = C.log.findIndex((x, k) => k > i && x.sql === 'COMMIT');
    for (const v of [P105, I105, DEF105, rel.SQL_RELACOES]) {
      const k = C.log.findIndex((x, n) => n > i && x.sql === v);
      assert.ok(k > i && k < iCommit && C.log[k].emTransacao && !C.log[k].ro, 'verificação dentro da transação, antes do COMMIT');
    }
    assert.ok(C.log.slice(iCommit).some(x => x.ro && x.sql === I105), 'integridade de novo em READ ONLY depois do COMMIT');
    assert.ok(!C.log.slice(iCommit).some(x => x.sql === P105), 'postcheck só dentro da transação');
    const m = JSON.parse(fs.readFileSync(r.marcador, 'utf8'));
    assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.backup, BACKUP); assert.deepEqual(m.commits, {105: 'CONFIRMADO'});
    assert.deepEqual(m.etapas.find(e => e.nome === 'migration 105').antesDoCommit, {'postcheck 105': 'PASS', ...COMPLETA_PASS});
    assert.deepEqual(m.etapas.find(e => e.nome === 'integridade 105').checks, COMPLETA_PASS);
    for (const v of [I105, DEF105, rel.SQL_RELACOES]) assert.ok(C.log.slice(iCommit).some(x => x.ro && x.sql === v), 'depois do COMMIT, em leitura');
    assert.ok(!fs.readFileSync(r.marcador, 'utf8').includes('SENHA_FALSA'));
    await assert.rejects(stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: clienteFalso(), disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('integridade divergente DENTRO da transação: ROLLBACK, nada confirmado', async () => {
  const dir = tmp();
  try {
    const C = clienteFalso({integraNaTransacao: false});
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /INTEGRIDADE_105 false/);
    assert.deepEqual(r.commits, {105: 'NAO_COMMITADA'}); assert.deepEqual(r.commitadas, []);
    const i = C.log.findIndex(x => x.sql === C105);
    assert.ok(!C.log.slice(i).some(x => x.sql === 'COMMIT'), 'COMMIT nunca enviado'); assert.ok(C.log.slice(i).some(x => x.sql === 'ROLLBACK'));
    assert.equal(comum.lerEstado(C.atual).m105, 'ausente', 'nada confirmado');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('situação do COMMIT na aplicação: corpo/verificação = NAO_COMMITADA; COMMIT 40003/08/sem resposta = INDETERMINADO; recusa = desfeita', async () => {
  const casos = [
    ['corpo (lock)', {falharEm: 'CREATE TABLE public.mcp_oauth_clientes', erro: erroPg('55P03')}, 'NAO_COMMITADA'],
    ['corpo (conexão caiu)', {falharEm: 'CREATE TABLE public.mcp_oauth_tokens', erro: new Error('Connection terminated unexpectedly')}, 'NAO_COMMITADA'],
    ['postcheck na transação', {falharEm: '105 postcheck: tabela', erro: erroPg('P0001')}, 'NAO_COMMITADA'],
    ['COMMIT 40003', {falharCommit: {n: 1, erro: erroPg('40003')}}, 'INDETERMINADO'],
    ['COMMIT 08006', {falharCommit: {n: 1, erro: erroPg('08006')}}, 'INDETERMINADO'],
    ['COMMIT sem resposta', {falharCommit: {n: 1, erro: new Error('Connection terminated unexpectedly')}}, 'INDETERMINADO'],
    ['COMMIT recusado (23503)', {falharCommit: {n: 1, erro: erroPg('23503')}}, 'DESFEITA_PELO_SERVIDOR'],
    ['COMMIT respondido como ROLLBACK', {falharCommit: {n: 1, rollback: true}}, 'DESFEITA_PELO_SERVIDOR'],
  ];
  for (const [rotulo, opcoes, commit] of casos) {
    const dir = tmp();
    try {
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: clienteFalso(opcoes), disco: semDisco});
      assert.equal(r.resultado, 'FALHA', rotulo + JSON.stringify(r)); assert.deepEqual(r.commits, {105: commit}, rotulo);
      assert.match(r.reconciliar, /--conferir-105/);
      const m = JSON.parse(fs.readFileSync(r.marcador, 'utf8'));
      assert.equal(m.situacao, 'FALHA'); assert.deepEqual(m.commits, {105: commit}, rotulo + ' (marcador)');
      await assert.rejects(stg.principal(['--aplicar-105-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso(), dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('retomada autorizada: COMMIT indeterminado que confirmou; marcador renomeado → nova execução só confere a integridade', async () => {
  const dir = tmp();
  try {
    const C1 = clienteFalso({falharCommit: {n: 1, erro: erroPg('08006')}});
    const r1 = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C1, disco: semDisco});
    assert.deepEqual(r1.commits, {105: 'INDETERMINADO'});
    fs.renameSync(path.join(dir, comum.MARCADOR), path.join(dir, 'migration-105.2026-10-27T21-00.json'));
    const C2 = clienteFalso({inicial: estado({...COMPLETA, ler_105: true})});
    const r2 = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C2, disco: semDisco});
    assert.equal(r2.resultado, 'JA_APLICADA_INTEGRIDADE_PASS', JSON.stringify(r2)); assert.deepEqual(r2.etapas, ['integridade 105']); assert.deepEqual(r2.commits, {});
    assert.deepEqual(escritas(C2.log), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8')).tentativasAnteriores, ['migration-105.2026-10-27T21-00.json']);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('estado que não completa depois do COMMIT, integridade falsa depois do COMMIT e mudança antes da aplicação: recusa', async () => {
  for (const [opcoes, motivo, commits] of [[{naoCompleta: true}, /ESTADO_DEPOIS_105/, {105: 'CONFIRMADO'}], [{integra: false}, /INTEGRIDADE_105 false/, {105: 'CONFIRMADO'}],
    [{inicial: estado({m105_funcao: 1})}, /APLICACAO_PARCIAL_105/, {}]]) {
    const dir = tmp();
    try {
      const C = clienteFalso(opcoes);
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, motivo); assert.deepEqual(r.commits, commits);
      if (opcoes.inicial) assert.deepEqual(escritas(C.log), []);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
  await assert.rejects(stg.executar({env: ENV_STG, backup: BACKUP, dir: tmp(), Client: clienteFalso(), disco: () => assert.fail('DISCO_PERSISTENTE_AUSENTE')}), /DISCO_PERSISTENTE_AUSENTE/);
  const dir2 = tmp();
  try {
    const x = await stg.principal(['--aplicar-105-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso({falharEm: 'CREATE TABLE public.mcp_auditoria'}), dir: dir2, disco: semDisco});
    assert.equal(x.codigo, 2); assert.equal(x.saida.resultado, 'FALHA');
  } finally { fs.rmSync(dir2, {recursive: true, force: true}); }
});

test('plano sem conexão: 4 arquivos com sha, prova no alvo, ordem com PITR e canal separado, paradas; nunca o down nem env', async () => {
  const {codigo, saida} = await stg.principal([], {});
  assert.equal(codigo, 0); assert.equal(saida.conecta, false); assert.equal(saida.ambiente, 'staging');
  assert.deepEqual(saida.arquivos.map(a => a.sha256), comum.ARQUIVOS.map(e => e[2]));
  assert.match(saida.provaNoAlvo, /antes do COMMIT/);
  assert.match(saida.ordem[0], /deploy do código/);
  assert.ok(saida.ordem.some(o => /PITR/.test(o)) && saida.ordem.some(o => /imediatamente antes/.test(o)) && saida.ordem.some(o => /SHARE ROW EXCLUSIVE/.test(o)));
  assert.ok(saida.ordem.some(o => /MCP_ENABLED/.test(o) && /SEPARADO/.test(o)), 'ligar o canal é passo separado');
  assert.ok(saida.preRequisitos.some(p => /NÃO liga o canal/.test(p)) && saida.preRequisitos.some(p => /REFERENCES em usuarios_administrativos e empresas/.test(p)));
  assert.ok(saida.paradas.some(p => /nunca apagar/.test(p)) && saida.paradas.some(p => /INDETERMINADO/.test(p)) && saida.paradas.some(p => /marcador incompleto ou ilegível/.test(p)));
  assert.ok(saida.nuncaExecuta.includes('down 105') && saida.nuncaExecuta.some(n => /MCP_ENABLED/.test(n)));
  assert.ok(!saida.arquivos.some(a => a.arquivo.includes('rollback')));
});

// ---- Conferência pela definição no aplicador de STAGING (follow-up do parecer do Astra r1 do aplicador de produção) ----
const COMPLETA_STG = Object.freeze({inicial: estado({...COMPLETA, ler_105: true})});
const TRECHO_DEF = 'Integridade REFORÇADA da 105';
const TRECHO_REL = rel.miolo('mcp_auditoria') + ' AS mcp_auditoria';
const contou = C => C.log.some(l => l.sql.includes('AS concessoes_ativas'));
const lerMarcador = arquivo => fs.readFileSync(arquivo, 'utf8');

test('CONFERIR pela definição: mutantes de definição e de relação → RECUSARIA (3), contagens nem enviadas, saída sem texto do banco', async () => {
  assert.ok(DEF105.includes(TRECHO_DEF) && rel.SQL_RELACOES.includes(TRECHO_REL));
  const casos = [
    ...Object.entries(MUTANTES_DEF).map(([nome, f]) => [nome, {defs: f(linhasDef())}, 'DEFINICOES_105 DIVERGENTE', 'definicoes 105']),
    ...Object.entries(MUTANTES_REL).map(([nome, [f, esperado]]) => [nome, {rel: f(relOk())}, 'RELACOES_105 DIVERGENTE', 'relacoes 105', esperado]),
    ['integridade antiga', {integra: false}, 'INTEGRIDADE_105 false', 'integridade 105'],
  ];
  for (const [nome, opcoes, motivo, check, esperado] of casos) {
    const C = clienteFalso({...COMPLETA_STG, ...opcoes});
    const x = await stg.principal(['--conferir-105'], ENV_STG, {Client: C});
    assert.equal(x.codigo, 3, nome); assert.equal(x.saida.resultado, 'RECUSARIA', nome); assert.equal(x.saida.motivo, motivo, nome);
    assert.equal(x.saida.checks[check], 'FALHOU', nome);
    for (const outro of comum.CONFERENCIA_COMPLETA.filter(n => n !== check)) assert.equal(x.saida.checks[outro], 'PASS', nome + ' ' + outro);
    if (esperado) assert.ok(x.saida.detalhes.divergenciasRelacoes.includes(esperado), nome);
    else if (check === 'definicoes 105') assert.ok(x.saida.detalhes.divergencias.length > 0, nome);
    assert.equal(x.saida.contagens, undefined, nome); assert.equal(contou(C), false, nome + ': contagens nem enviadas');
    assert.deepEqual(escritas(C.log), [], nome);
    assert.doesNotMatch(JSON.stringify(x), MARCADOR_RE, nome + ': sem o marcador');
    assert.doesNotMatch(JSON.stringify(x), /tabela_externa|nome_fk/, nome + ': sem nomes do banco');
  }
  assert.deepEqual((await stg.conferir({env: ENV_STG, Client: clienteFalso({...COMPLETA_STG, rel: MUTANTES_REL['PG 17 (sem referência)'][0](relOk())})})).detalhes.divergenciasRelacoes,
    ['SEM_REFERENCIA_PG 17']);
  // Antes da 105 (PRONTA_PARA_APLICAR) definições e relações não são lidas: as tabelas não existem.
  const P = clienteFalso({defs: [], rel: {versao_pg: 180006}});
  assert.equal((await stg.conferir({env: ENV_STG, Client: P})).resultado, 'PRONTA_PARA_APLICAR');
  assert.ok(!P.log.some(l => l.sql === DEF105 || l.sql === rel.SQL_RELACOES));
});

test('CONFERIR: integridade, definições, relações e contagens numa só fotografia REPEATABLE READ READ ONLY; deparse com search_path próprio', async () => {
  const C = clienteFalso(COMPLETA_STG);
  assert.equal((await stg.conferir({env: ENV_STG, Client: C})).resultado, 'JA_APLICADA_INTEGRIDADE_PASS');
  const sqls = C.log.map(l => l.sql);
  const k = [sqls.indexOf(I105), sqls.indexOf(DEF105), sqls.indexOf(rel.SQL_RELACOES), sqls.findIndex(s => s.includes('AS concessoes_ativas'))];
  assert.ok(k.every(i => i > 0 && C.log[i].ro), 'todas em leitura');
  assert.ok(k[0] < k[1] && k[1] < k[2] && k[2] < k[3], 'ordem: integridade, definições, relações, contagens');
  const inicio = sqls.lastIndexOf(comum.BEGIN_LEITURA, k[0]);
  assert.ok(inicio >= 0 && !sqls.slice(inicio, k[3]).some(s => s === 'ROLLBACK' || s === 'COMMIT' || s.startsWith('BEGIN') && s !== comum.BEGIN_LEITURA), 'uma transação só');
  assert.equal(sqls.slice(inicio + 1, k[3]).filter(s => s === comum.BEGIN_LEITURA).length, 0, 'sem outro BEGIN no meio');
  assert.match(comum.BEGIN_LEITURA, /REPEATABLE READ READ ONLY$/);
  for (const s of defs.SET_DEPARSE) { const i = sqls.indexOf(s, inicio); assert.ok(i > k[0] && i < k[1], s); }
  const volta = sqls.indexOf('SET LOCAL search_path = public, pg_catalog', k[2]);
  assert.ok(volta > k[2] && volta < k[3], 'search_path de volta antes das contagens');
});

test('guarda de reaplicação (105 completa): definição, relação ou integridade divergente → FALHA (2) sem escrita, sem COMMIT, sem contagens', async () => {
  const casos = [['definição', {defs: MUTANTES_DEF['RLS ligada'](linhasDef())}, 'DEFINICOES_105 DIVERGENTE'],
    ['relação', {rel: MUTANTES_REL['FK de entrada vinda de fora da 105'][0](relOk())}, 'RELACOES_105 DIVERGENTE'],
    ['relação com LF e marcador', {rel: MUTANTES_REL['LF no nome de FK de entrada externa'][0](relOk())}, 'RELACOES_105 DIVERGENTE'],
    ['integridade antiga', {integra: false}, 'INTEGRIDADE_105 false']];
  for (const [nome, opcoes, motivo] of casos) {
    const dir = tmp();
    try {
      const C = clienteFalso({...COMPLETA_STG, ...opcoes});
      const x = await stg.principal(['--aplicar-105-autorizado', '--backup', BACKUP], ENV_STG, {Client: C, dir, disco: semDisco});
      assert.equal(x.codigo, 2, nome); assert.equal(x.saida.resultado, 'FALHA', nome);
      assert.equal(x.saida.falha.mensagem, motivo, nome); assert.equal(x.saida.falha.etapa, 'integridade 105', nome);
      assert.deepEqual(x.saida.commits, {}, nome); assert.deepEqual(escritas(C.log), [], nome);
      assert.ok(!C.log.some(l => l.sql === 'COMMIT') && !contou(C), nome + ': sem COMMIT e sem contagens');
      const texto = lerMarcador(x.saida.marcador), m = JSON.parse(texto);
      assert.equal(m.situacao, 'FALHA', nome); assert.equal(m.contagensAntes, undefined, nome); assert.equal(m.contagensDepois, undefined, nome);
      const passo = m.etapas.find(e => e.nome === 'integridade 105');
      assert.equal(passo.ok, undefined, nome); assert.ok(Object.values(passo.checks).includes('FALHOU'), nome);
      assert.doesNotMatch(texto, MARCADOR_RE, nome); assert.doesNotMatch(texto, /tabela_externa|nome_fk/, nome);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
  // Íntegra: a guarda passa e só então lê as contagens (antes e depois são a mesma fotografia, nada escrito).
  const dir = tmp();
  try {
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: clienteFalso(COMPLETA_STG), disco: semDisco});
    assert.equal(r.resultado, 'JA_APLICADA_INTEGRIDADE_PASS'); assert.deepEqual(r.contagensAntes, CONTAGENS); assert.deepEqual(r.contagensDepois, CONTAGENS);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('antes do COMMIT: definição ou relação divergente NA transação → ROLLBACK, NAO_COMMITADA; depois do COMMIT → FALHA com CONFIRMADO', async () => {
  const casos = [['definição (dono)', {defsNaTransacao: MUTANTES_DEF['dono diferente'](linhasDef())}, 'DEFINICOES_105 DIVERGENTE', 'definicoes 105'],
    ['definição (chave do banco)', {defsNaTransacao: MUTANTES_DEF['chave desconhecida (nome do banco)'](linhasDef())}, 'DEFINICOES_105 DIVERGENTE', 'definicoes 105'],
    ['relação (NOT NULL NOT VALID)', {relNaTransacao: MUTANTES_REL['NOT NULL NOT VALID (PG 18)'][0](relOk())}, 'RELACOES_105 DIVERGENTE', 'relacoes 105']];
  for (const [nome, opcoes, motivo, check] of casos) {
    const dir = tmp();
    try {
      const C = clienteFalso(opcoes);
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'FALHA', nome); assert.equal(r.falha.mensagem, motivo, nome); assert.deepEqual(r.commits, {105: 'NAO_COMMITADA'}, nome);
      const i = C.log.findIndex(x => x.sql === C105);
      assert.ok(!C.log.slice(i).some(x => x.sql === 'COMMIT'), nome + ': COMMIT nunca enviado'); assert.ok(C.log.slice(i).some(x => x.sql === 'ROLLBACK'), nome);
      assert.equal(comum.lerEstado(C.atual).m105, 'ausente', nome + ': nada confirmado');
      const texto = lerMarcador(r.marcador), passo = JSON.parse(texto).etapas.find(e => e.nome === 'migration 105');
      assert.equal(passo.faseDaFalha, 'verificacao', nome); assert.equal(passo.antesDoCommit[check], 'FALHOU', nome);
      assert.equal(passo.antesDoCommit['postcheck 105'], 'PASS', nome); assert.ok(passo.divergenciasAntesDoCommit, nome);
      assert.doesNotMatch(texto, MARCADOR_RE, nome);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
  const dir = tmp();
  try {
    const C = clienteFalso({defs: MUTANTES_DEF['RLS ligada'](linhasDef()), defsNaTransacao: linhasDef()});
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'FALHA'); assert.equal(r.falha.mensagem, 'DEFINICOES_105 DIVERGENTE'); assert.deepEqual(r.commits, {105: 'CONFIRMADO'});
    assert.equal(r.falha.etapa, 'integridade 105'); assert.equal(contou(C), false, 'sem contagens depois de uma conferência divergente');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('diagnóstico em vocabulário fechado: motivos próprios da lista, SQLSTATE, código de sistema; nunca a mensagem livre', () => {
  const d = stg.diagnostico;
  const propria = m => { try { assert.fail(m); } catch (e) { return e; } };
  for (const m of [...comum.MOTIVOS_NUCLEO, ...stg.MOTIVOS]) assert.equal(d(propria(m)), m);
  assert.equal(d(propria('TENTATIVA_ANTERIOR_REVISAR /opt/' + MARCADOR)), 'TENTATIVA_ANTERIOR_REVISAR');
  assert.equal(d(propria('ESTADO_ILEGIVEL ' + MARCADOR)), 'ESTADO_ILEGIVEL');
  assert.equal(d(propria('IDENTIDADE_RECUSADA ' + MARCADOR)), 'IDENTIDADE_RECUSADA');
  assert.equal(d(propria(MARCADOR + ' INTEGRIDADE_105 false')), 'ERRO_SISTEMA ERR_ASSERTION', 'fora da lista: só o código');
  assert.equal(d(propria('INTEGRIDADE_105 false' + LF + MARCADOR)), 'INTEGRIDADE_105 false', 'só a 1ª linha');
  try { assert.equal(MARCADOR, 'completa', 'ESTADO_DEPOIS_105'); assert.fail('não lançou'); } catch (e) { assert.equal(d(e), 'ESTADO_DEPOIS_105', 'sem o diff do assert'); }
  try { assert.equal(MARCADOR, 'x'); assert.fail('não lançou'); } catch (e) { assert.equal(d(e), 'ERRO_SISTEMA ERR_ASSERTION', 'mensagem gerada pelo assert: só o código'); }
  assert.equal(d(Object.assign(new Error('DEFINICOES_105 DIVERGENTE'), {code: 'ERR_ASSERTION'})), 'ERRO_SISTEMA ERR_ASSERTION', 'forjada sem generatedMessage');
  assert.equal(d(Object.assign(new Error('DEFINICOES_105 DIVERGENTE'), {code: 'ERR_ASSERTION', generatedMessage: true})), 'ERRO_SISTEMA ERR_ASSERTION');
  assert.equal(d(Object.assign(new Error('DEFINICOES_105 DIVERGENTE'), {code: '55P03', generatedMessage: false})), 'ERRO_SERVIDOR 55P03', 'só ERR_ASSERTION é asserção própria');
  for (const [code, esperado] of [['55P03', 'ERRO_SERVIDOR 55P03'], ['40003', 'ERRO_SERVIDOR 40003'], ['ABCDE', 'ERRO_NAO_CLASSIFICADO'], ['55P0', 'ERRO_NAO_CLASSIFICADO'],
    ['55p03', 'ERRO_NAO_CLASSIFICADO'], ['ENOSPC', 'ERRO_SISTEMA ENOSPC'], ['EIO', 'ERRO_SISTEMA EIO'], ['e-x', 'ERRO_NAO_CLASSIFICADO'], [undefined, 'ERRO_NAO_CLASSIFICADO']]) {
    assert.equal(d(erroMarcado(code)), esperado, String(code));
  }
  assert.equal(d(undefined), 'ERRO_NAO_CLASSIFICADO'); assert.equal(d(MARCADOR), 'ERRO_NAO_CLASSIFICADO');
  // Toda asserção com mensagem própria no núcleo e no adaptador tem o código na lista (nenhuma cai em ERRO_NAO_CLASSIFICADO).
  for (const arquivo of ['migration-105-comum.cjs', 'migration-105-staging.cjs']) {
    const fonte = fs.readFileSync(path.join(__dirname, arquivo), 'utf8');
    const codigos = [...fonte.matchAll(/assert\.(?:fail\(|(?:ok|equal|notEqual|match)\([^;]*?, )'([A-Z][A-Z0-9_]{3,})/g)].map(m => m[1]);
    assert.ok(codigos.length >= 10, arquivo + ' ' + codigos.length);
    for (const c of codigos) assert.ok(d.codigos.has(c), arquivo + ': ' + c);
  }
});

test('erros externos com o marcador: CONFERIR, APLICAR e marcador em disco saem só em vocabulário fechado', async () => {
  const semConexao = class extends clienteFalso() { async connect() { throw erroMarcado('08001'); } };
  const conferir = [
    ['conexão', semConexao, 'FALHA', 'ERRO_SERVIDOR 08001'],
    ['identidade (consulta)', clienteFalso({falharEm: 'SELECT current_database()', erro: erroMarcado('08006')}), 'FALHA', 'ERRO_SERVIDOR 08006'],
    ['estado', clienteFalso({falharEm: 'AS m105_tabelas', erro: erroMarcado('XX000')}), 'FALHA', 'ERRO_SERVIDOR XX000'],
    ['estado sem código', clienteFalso({falharEm: 'AS m105_tabelas', erro: new Error(MARCADOR)}), 'FALHA', 'ERRO_NAO_CLASSIFICADO'],
    ['precheck', clienteFalso({falharEm: '105 precheck', erro: erroMarcado('P0001')}), 'RECUSARIA', 'ERRO_SERVIDOR P0001'],
    ['integridade', clienteFalso({...COMPLETA_STG, falharEm: 'AS integra_105', erro: erroMarcado('42501')}), 'RECUSARIA', 'ERRO_SERVIDOR 42501', 'INTEGRIDADE'],
    ['definições', clienteFalso({...COMPLETA_STG, falharEm: TRECHO_DEF, erro: erroMarcado('XX000')}), 'RECUSARIA', 'ERRO_SERVIDOR XX000', 'INTEGRIDADE'],
    ['relações', clienteFalso({...COMPLETA_STG, falharEm: TRECHO_REL, erro: erroMarcado('XX000')}), 'RECUSARIA', 'ERRO_SERVIDOR XX000', 'INTEGRIDADE'],
    ['contagens', clienteFalso({...COMPLETA_STG, falharEm: 'AS concessoes_ativas', erro: erroMarcado('22P02')}), 'RECUSARIA', 'ERRO_SERVIDOR 22P02', 'CONTAGENS'],
    ['contagens sem código', clienteFalso({...COMPLETA_STG, falharEm: 'AS concessoes_ativas', erro: new Error(MARCADOR)}), 'RECUSARIA', 'ERRO_NAO_CLASSIFICADO', 'CONTAGENS'],
  ];
  for (const [nome, Client, resultado, motivo, fase] of conferir) {
    const x = await stg.principal(['--conferir-105'], ENV_STG, {Client});
    assert.equal(x.saida.resultado, resultado, nome); assert.equal(x.codigo, resultado === 'FALHA' ? 2 : 3, nome);
    assert.equal(x.saida.motivo ?? x.saida.mensagem, motivo, nome);
    if (fase) assert.equal(x.saida.fase, fase, nome);
    assert.doesNotMatch(JSON.stringify(x), MARCADOR_RE, nome);
  }
  const aplicar = [
    ['DDL', {falharEm: 'CREATE TABLE public.mcp_auditoria', erro: erroMarcado('42P07')}, 'ERRO_SERVIDOR 42P07', {105: 'NAO_COMMITADA'}, 'corpo'],
    ['definições na transação', {falharEm: TRECHO_DEF, erro: erroMarcado('XX000')}, 'ERRO_SERVIDOR XX000', {105: 'NAO_COMMITADA'}, 'verificacao'],
    ['relações na transação', {falharEm: TRECHO_REL, erro: new Error(MARCADOR)}, 'ERRO_NAO_CLASSIFICADO', {105: 'NAO_COMMITADA'}, 'verificacao'],
    ['COMMIT 08006', {falharCommit: {n: 1, erro: erroMarcado('08006')}}, 'ERRO_SERVIDOR 08006', {105: 'INDETERMINADO'}, 'commit'],
    ['COMMIT sem código', {falharCommit: {n: 1, erro: new Error(MARCADOR)}}, 'ERRO_NAO_CLASSIFICADO', {105: 'INDETERMINADO'}, 'commit'],
    ['105 completa: contagens', {...COMPLETA_STG, falharEm: 'AS concessoes_ativas', erro: erroMarcado('22P02')}, 'ERRO_SERVIDOR 22P02', {}, null],
  ];
  for (const [nome, opcoes, mensagem, commits, faseDaFalha] of aplicar) {
    const dir = tmp();
    try {
      const x = await stg.principal(['--aplicar-105-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso(opcoes), dir, disco: semDisco});
      assert.equal(x.codigo, 2, nome); assert.equal(x.saida.falha.mensagem, mensagem, nome); assert.deepEqual(x.saida.commits, commits, nome);
      const textos = fs.readdirSync(dir).map(n => fs.readFileSync(path.join(dir, n), 'utf8'));
      assert.ok(textos.length >= 1, nome);
      for (const t of textos) assert.doesNotMatch(t, MARCADOR_RE, nome + ': arquivos do diretório sem o marcador');
      assert.doesNotMatch(JSON.stringify(x), MARCADOR_RE, nome);
      const m = JSON.parse(textos[0]);
      if (faseDaFalha) assert.equal(m.etapas.find(e => e.nome === 'migration 105').faseDaFalha, faseDaFalha, nome);
      else assert.equal(m.etapas.find(e => e.nome === 'integridade 105').fase, 'CONTAGENS', nome);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('CLI: a linha RECUSADO também sai em vocabulário fechado', async () => {
  const orig = {argv: process.argv, erro: console.error, codigo: process.exitCode};
  const linhas = [];
  try {
    console.error = l => linhas.push(String(l));
    for (const [argv, esperado] of [[['--aplicar-105-autorizado'], 'RECUSADO BACKUP_OBRIGATORIO'], [['--outra'], 'RECUSADO ARGUMENTOS_RECUSADOS']]) {
      process.argv = ['node', 'migration-105-staging.cjs', ...argv];
      const antes = linhas.length;
      stg.cli();
      for (let i = 0; i < 50 && linhas.length === antes; i++) await new Promise(r => setImmediate(r));
      assert.equal(linhas.at(-1), esperado); assert.equal(process.exitCode, 1);
    }
  } finally { process.argv = orig.argv; console.error = orig.erro; process.exitCode = orig.codigo; }
});
