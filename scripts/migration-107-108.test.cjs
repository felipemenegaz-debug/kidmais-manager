/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 107/108 (reparo da agenda + salões combinados, staging) com cliente simulado que só CONFIRMA no COMMIT e
// descarta no ROLLBACK (plano E4 rev. 2 + critérios da rev. 2.1; D-E1..D-E4). Sem banco. Cobre: hashes LF com linha
// final; moldura das migrations; precheck pré-107 = precheck da 108 menos a cláusula da 107; catálogo num só SELECT;
// classificação da 108 igual à de lib/agenda/estado-combinados.ts; MATRIZ enumerada estado da 107 × estado da 108 × modo;
// privilégios por fase com revogações individuais; atividade (preparada, sem contexto, entre as etapas); fases F0/F1/F2 e
// revalidação DENTRO de cada transação; ordem dos locks; COMMIT por etapa (antes, durante e depois; ROLLBACK respondido);
// marcadores por execução e por etapa (existente, ilegível, sem permissão, gravação falhando); retomada só da 108; PLANO
// sem conexão; CONFERIR só leitura; esperados não medidos (RETRATO_NAO_MEDIDO) e override de teste recusado no staging.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const comum = require('./migration-107-108-comum.cjs');
const stg = require('./migration-107-108-staging.cjs');
const def107 = require('./migration-107-definicoes.cjs');
const ret108 = require('./migration-108-retrato.cjs');
/** Esperados todos pendentes, SIMULADOS sobre o objeto do módulo (o arquivo versionado já está medido desde 29/10/2026). */
async function comEsperadosPendentes(corpo) {
  const P = ret108.PENDENTE;
  const pend = {...ret108.carregarEsperados(), F0: {canonico: P, deriva_conhecida: P}, F1: {canonico: P}, F2: {canonico: P}};
  const o = {h: ret108.hashesAceitos, c: ret108.compararRetrato108, p: ret108.sqlProva108Integra};
  ret108.hashesAceitos = (f, _e, op) => o.h(f, pend, op);
  ret108.compararRetrato108 = (f, l, _e, op) => o.c(f, l, pend, op);
  ret108.sqlProva108Integra = (op = {}) => o.p({...op, esperados: pend});
  try { return await corpo(); } finally { Object.assign(ret108, {hashesAceitos: o.h, compararRetrato108: o.c, sqlProva108Integra: o.p}); }
}

const raiz = path.resolve(__dirname, '..');
const URL_STG = 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91';
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false', DATABASE_URL: URL_STG});
const ID_STG = {db: 'kidmais_staging_1z91', tls: false, servidor_privado: true};
const BACKUP = 'PITR 29/10 21:00Z ref-1';
const DRENAGEM = 'web escala zero 21:05Z cron suspenso';
const H = c => c.repeat(64);
/** Esperados FICTÍCIOS (só nos testes; o formato e o trecho_sha256 são os reais). */
const ESPERADOS = Object.freeze({versao_pg_maior: 18, trecho_sha256: ret108.hashTrecho(ret108.trechoRetrato108()),
  F0: {canonico: H('a'), deriva_conhecida: H('b')}, F1: {canonico: H('c')}, F2: {canonico: H('d')}});
const ENV_TESTE = Object.freeze({...ENV_STG, [comum.ENV_RETRATOS_TESTE]: JSON.stringify(ESPERADOS)});
const ler = nome => { const [, a, h] = comum.ARQUIVOS.find(e => e[0] === nome); return comum.lerRevisado(raiz, a, h); };
const M107 = ler('migration 107'), M108 = ler('migration 108');
const C107 = comum.semMoldura(M107, 'm107'), C108 = comum.semMoldura(M108, 'm108');
const AV = def107.sqlAvaliacao107(), IN = def107.sqlIntegridade107(), RT = ret108.sqlRetrato108({raiz});
const PV = ret108.sqlProva108Integra({esperados: ESPERADOS, raiz});
const ARQ = Object.fromEntries(comum.ARQUIVOS.map(([n]) => [n, ler(n)]));
const erroPg = (code, msg = 'erro simulado') => Object.assign(new Error(msg), {code});
const semDisco = () => {};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-107-108-'));

/** Aplicador de TESTE: o mesmo núcleo e a mesma trava do staging, aceitando os esperados injetados. */
const teste = comum.criarAplicador({nome: 'teste', ALVO: stg.ALVO, DIR: '/nao-usado', SQL_IDENTIDADE: stg.SQL_IDENTIDADE,
  alvo: env => { const copia = {...env}; delete copia[comum.ENV_RETRATOS_TESTE]; return stg.alvo(copia); }, identidade: stg.identidade,
  exigirDisco: () => {}, aceitaRetratosTeste: true});

const PRIVILEGIOS = ['usar_public', 'pode_criar', 'temp', 'plpgsql', 'linguagem_sql', ...comum.TABELAS_LEITURA.map(t => 'ler_' + t), 'ler_reparos', 'executar_ocupacoes',
  'dono_bloqueios', 'dono_config_agenda', 'gatilho_bloqueios', 'gatilho_config_agenda', 'travar_bloqueios', 'travar_config_agenda', 'executar_set_atualizado', 'dono_saloes',
  'dono_contratos', 'dono_funcoes_108', 'gatilho_saloes', 'gatilho_contratos', 'travar_saloes', 'travar_contratos', 'ver_atividade'];
const CORPO_100 = '805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb';
const CONTRATO_094 = '4d462947bc173967fe9ff059a4aa857bd068502c042ae81a97c918e3362bf43e';
const REVISAO_094 = '951825ad597495b477963ebb74df0120c1e8f4c59d39f6b7b32f53e5baaea821';
/** Catálogo da 108 por estado (o mesmo que classificarCombinados lê). */
const CAT108 = {
  AUSENTE: {c_funcoes: 0, c_funcoes_qualquer: 0, c_combinado: false, c_membros: false, c_check: false, c_gatilhos: 0, c_gatilhos_qualquer: 0,
    c_conflito: CORPO_100, c_contrato: CONTRATO_094, c_revisao: REVISAO_094, c_marcador: false},
  NOVA: {c_funcoes: 10, c_funcoes_qualquer: 10, c_combinado: true, c_membros: true, c_check: true, c_gatilhos: 6, c_gatilhos_qualquer: 6,
    c_conflito: ret108.NOVA.hashes.conflito108, c_contrato: ret108.NOVA.hashes.contrato, c_revisao: ret108.NOVA.hashes.revisao, c_marcador: true},
};
CAT108.ANTIGA = {...CAT108.NOVA, c_conflito: comum.CONFLITO_098, c_marcador: false};
CAT108.PARCIAL = {...CAT108.NOVA, c_gatilhos: 5};
const estadoLinha = (m, extra = {}) => ({versao_pg: 180006, base107: true, registro107: m.m107 !== 'ausente', d108: true, ...CAT108[m.m108],
  ...Object.fromEntries(PRIVILEGIOS.map(p => [p, true])), papel_trocado: true, ...extra});
const SEM_ATIVIDADE = Object.freeze({locks: 0, sessoes: 0, sessoes_em_transacao: 0, locks_sem_pid: 0, sem_contexto: 0});
const SESSOES = Object.freeze({outras: 0, nao_ociosas: 0, em_transacao: 0});

/**
 * Cliente simulado transacional. Modelo: m107 ausente|aplicada|divergente, m108 AUSENTE|NOVA|ANTIGA|PARCIAL, deriva (F0
 * com a deriva conhecida), extra (linha do catálogo), recusa107 (avaliação com RECUSA), retratoDiverge, avaria108 (prova
 * falha), festaInativa (precheck da 108 falha). Falhas: falharEm (trecho; soNaTransacao), falharCommit {n, erro|rollback},
 * naoCompleta (o COMMIT não muda o estado), avariaDepois (a prova falha depois do COMMIT da 108), atividade (objeto ou
 * função do nº da leitura), executa.
 */
function clienteFalso(opcoes = {}) {
  const {m107 = 'ausente', m108 = 'AUSENTE', deriva = false, extra = {}, recusa107 = false, retratoDiverge = false, avaria108 = false, festaInativa = false,
    falharEm, soNaTransacao = false, erro, falharCommit, naoCompleta, avariaDepois = false, atividade = SEM_ATIVIDADE, executa = true, identidade = ID_STG} = opcoes;
  const log = []; let ro = false, tx = false, caminho = null, pendente = null, commits = 0, leiturasAtividade = 0, avariado = avaria108;
  const atual = {m107, m108};
  const visao = () => (pendente ? {...atual, ...pendente} : atual);
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') ro = true;
      if (sql === 'BEGIN') { tx = true; }
      const m = /^SET LOCAL search_path = (.*)$/.exec(sql); if (m) caminho = m[1];
      log.push({sql, ro, tx, caminho});
      if (falharEm && sql.includes(falharEm) && (!soNaTransacao || tx)) throw erro ?? erroPg('P0001', 'falha simulada em ' + falharEm);
      if (sql === 'ROLLBACK') { ro = false; tx = false; pendente = null; caminho = null; return {rows: [], command: 'ROLLBACK'}; }
      if (sql === 'COMMIT') {
        commits++; tx = false; caminho = null;
        if (falharCommit && falharCommit.n === commits) {
          pendente = null;
          if (falharCommit.rollback) return {rows: [], command: 'ROLLBACK'};
          throw falharCommit.erro;
        }
        if (pendente && naoCompleta !== pendente.id) Object.assign(atual, pendente);
        if (pendente?.id === '108' && avariaDepois) avariado = true;
        pendente = null;
        return {rows: [], command: 'COMMIT'};
      }
      if (sql.startsWith('SET LOCAL ') || sql === 'BEGIN' || sql === 'BEGIN TRANSACTION READ ONLY') return {rows: []};
      const v = visao();
      if (sql.startsWith('SELECT current_database()')) return {rows: [identidade]};
      if (sql === comum.SQL_ESTADO) return {rows: [estadoLinha(v, extra)]};
      if (sql === comum.SQL_ATIVIDADE) { leiturasAtividade++; return {rows: [{...(typeof atividade === 'function' ? atividade(leiturasAtividade) : atividade)}]}; }
      if (sql === comum.SQL_SESSOES) return {rows: [{...SESSOES}]};
      if (sql === AV) {
        return {rows: def107.DEFINICOES.map(d => ({n: d.n, canonico: d.canonico, ja_aplicada: v.m107 !== 'ausente', pg_maior: 18,
          estado: recusa107 && d.n === 4 ? 'RECUSA:DEFINICAO_DIFERENTE' : !deriva ? 'CANONICO' : d.tipo === 'N' || d.tipo === 'T' ? 'AUSENTE_CRIAVEL' : 'DERIVA'}))};
      }
      if (sql === IN) {
        return {rows: v.m107 === 'aplicada' ? [{ok: true, motivo: 'pg'}, {ok: true, motivo: 'base'}]
          : [{ok: true, motivo: 'pg'}, {ok: false, motivo: v.m107 === 'ausente' ? 'registro kidmais107_reparos ausente' : 'bloqueios_agenda_periodo_check com definição diferente'}]};
      }
      if (sql === RT) {
        const h = retratoDiverge ? H('e') : v.m107 === 'ausente' && v.m108 === 'AUSENTE' ? (deriva ? H('b') : H('a'))
          : v.m107 === 'aplicada' && v.m108 === 'AUSENTE' ? H('c') : v.m107 === 'aplicada' && v.m108 === 'NOVA' ? H('d') : H('f');
        return {rows: [{hash_108: h, retrato_108: {funcoes: [['x()', 'h']], marcador_108: null}, search_path: caminho, versao_pg: 180006}]};
      }
      if (sql === PV) {
        const integra = v.m107 === 'aplicada' && v.m108 === 'NOVA' && !avariado;
        return {rows: [{integra, motivos: integra ? [] : ['MARCADOR_108', 'RETRATO_F2']}]};
      }
      if (sql === ARQ['precheck 107'] && v.m107 !== 'ausente') throw erroPg('P0001', '107 precheck: agenda da 005 ausente ou 107 já aplicada');
      if (sql === ARQ['precheck 108 pre-107'] && (v.m108 !== 'AUSENTE' || festaInativa)) throw erroPg('P0001', '108: precheck falhou');
      if (sql === ARQ['precheck 108'] && (v.m107 !== 'aplicada' || v.m108 !== 'AUSENTE' || festaInativa)) throw erroPg('P0001', '108: precheck falhou (107 ausentes)');
      if (sql === ARQ['integridade 107'] && v.m107 !== 'aplicada') throw erroPg('P0001', '107 integridade: registro ausente');
      if (sql === ARQ['postcheck 108'] && v.m108 !== 'NOVA') throw erroPg('P0001', '108 postcheck: instalação incompleta');
      if (sql === comum.SQL_EXECUCAO_108) return {rows: [{executa_108: executa}]};
      if (sql === C107) { assert.ok(tx && !ro, 'corpo só em transação de escrita'); pendente = {id: '107', m107: 'aplicada'}; }
      if (sql === C108) { assert.ok(tx && !ro, 'corpo só em transação de escrita'); pendente = {id: '108', m108: 'NOVA'}; }
      assert.ok(sql !== M107 && sql !== M108, 'o arquivo COM a moldura nunca é enviado');
      return {rows: []};
    }
  };
  C.log = log; C.atual = atual;
  return C;
}
/** Instruções que escrevem (fora de READ ONLY): o que não é controle, leitura de catálogo nem verificação. */
const escritas = log => log.filter(x => !x.ro && (x.sql === C107 || x.sql === C108 || x.sql.startsWith('LOCK TABLE')));
const corpos = log => log.filter(x => x.sql === C107 || x.sql === C108).map(x => (x.sql === C107 ? '107' : '108'));
const aplicar = (Client, extra = {}) => teste.executar({env: ENV_TESTE, backup: BACKUP, drenagem: DRENAGEM, dir: extra.dir ?? tmp(), Client, disco: semDisco, ...extra});
const conferir = Client => teste.conferir({env: ENV_TESTE, Client});

test('arquivos: hashes LF com linha final; downs fixados; sem linha final recusa; migrations de UMA transação enviadas sem moldura', () => {
  for (const [, a, h] of [...comum.ARQUIVOS, ...comum.RECUPERACAO]) {
    const t = fs.readFileSync(path.join(raiz, a), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(t.endsWith('\n'), a); assert.equal(createHash('sha256').update(t).digest('hex'), h, a);
  }
  assert.deepEqual(comum.ARQUIVOS.map(e => e[0]), ['precheck 107', 'migration 107', 'integridade 107', 'precheck 108 pre-107', 'precheck 108', 'migration 108',
    'postcheck 108', 'retrato 108', 'retratos esperados 108']);
  const d = tmp();
  try {
    const semFinal = ARQ['precheck 107'].slice(0, -1);
    fs.writeFileSync(path.join(d, 'x.sql'), semFinal);
    assert.throws(() => comum.lerRevisado(d, 'x.sql', createHash('sha256').update(semFinal).digest('hex')), /SEM_LINHA_FINAL x\.sql/);
    fs.writeFileSync(path.join(d, 'y.sql'), ARQ['precheck 107'].replace(/\n/g, '\r\n'));
    assert.equal(comum.lerRevisado(d, 'y.sql', comum.ARQUIVOS[0][2]), ARQ['precheck 107'], 'CRLF normalizado');
    assert.throws(() => comum.lerRevisado(d, 'y.sql', H('0')), /ARQUIVO_DIVERGENTE/);
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
  for (const [m, c] of [[M107, C107], [M108, C108]]) {
    assert.equal(m.replace(/^BEGIN;\n/m, '').slice(0, -'COMMIT;\n'.length), c);
    assert.doesNotMatch(c, /^BEGIN;$/m); assert.doesNotMatch(c, /^COMMIT;$/m); assert.match(c, /SET LOCAL search_path = public, pg_catalog;/);
  }
  assert.throws(() => comum.semMoldura(M107 + 'COMMIT;\n', 'x'), /TRANSACAO_INESPERADA/);
  assert.throws(() => comum.semMoldura(M108.replace('BEGIN;\n', ''), 'x'), /TRANSACAO_INESPERADA/);
  assert.throws(() => comum.semMoldura(C108, 'x'), /TRANSACAO_INESPERADA/);
});

test('precheck da 108 pré-107 = o precheck da 108 MENOS só a exigência de kidmais107_reparos (arquivo = gerado)', () => {
  const original = ARQ['precheck 108'], pre = ARQ['precheck 108 pre-107'];
  assert.equal(pre, comum.precheckPre107(original));
  assert.ok(pre.startsWith(comum.CABECALHO_PRE107));
  assert.equal(pre.slice(comum.CABECALHO_PRE107.length).replace(' THEN\n    RAISE EXCEPTION \'108: precheck falhou (093/094/100/102/104/106/107',
    comum.CLAUSULA_107 + '\n    RAISE EXCEPTION \'108: precheck falhou (093/094/100/102/104/106/107'), original, 'reinserir a cláusula devolve o original');
  assert.doesNotMatch(pre, /kidmais107_reparos'\) IS NULL/);
  assert.equal(original.split('\n').length - 1, pre.slice(comum.CABECALHO_PRE107.length).split('\n').length, 'uma linha a menos (a da cláusula)');
  for (const trecho of ['kidmais094_ocupacoes', 'kidmais102_salao_conteudo()', 'hash_versao', 'salao_preferido_id', 'kidmais108_instalada()', CORPO_100, 'NOT s.ativo']) {
    assert.ok(pre.includes(trecho), trecho);
  }
  assert.throws(() => comum.precheckPre107(pre.slice(comum.CABECALHO_PRE107.length)), /PRECHECK_108_SEM_CLAUSULA_107/);
});

test('SQL_ESTADO: só catálogo, sem cast antecipado; privilégios por has_*_privilege; 108 espelha estado-combinados.ts', () => {
  const sem = comum.SQL_ESTADO.replace(/'[^']*'/g, "''");
  assert.doesNotMatch(sem, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|TRUNCATE)\b/);
  const fontes = [...new Set([...comum.SQL_ESTADO.matchAll(/\bFROM\s+([a-z_.]+)/g)].map(m => m[1]))].sort();
  assert.deepEqual(fontes, ['pg_attribute', 'pg_class', 'pg_constraint', 'pg_proc', 'pg_roles', 'pg_trigger'], 'só catálogo');
  assert.doesNotMatch(comum.SQL_ESTADO, /'public\.[a-z_0-9(),]+'::reg(class|procedure)/, 'sem cast antecipado');
  const priv = (t, p) => `has_table_privilege(current_user, oid, '${p}') FROM pg_class WHERE oid = to_regclass('public.${t}')`;
  for (const t of [...comum.TABELAS_LEITURA, 'kidmais107_reparos']) assert.ok(comum.SQL_ESTADO.includes(priv(t, 'SELECT')), 'SELECT ' + t);
  for (const t of ['bloqueios_agenda', 'configuracao_agenda', 'agenda_saloes', 'contratos']) {
    for (const p of ['TRIGGER', 'UPDATE', 'DELETE', 'TRUNCATE', 'MAINTAIN']) assert.ok(comum.SQL_ESTADO.includes(priv(t, p)), t + ' ' + p);
    assert.ok(comum.SQL_ESTADO.includes(`pg_has_role(current_user, relowner, 'USAGE') FROM pg_class WHERE oid = to_regclass('public.${t}')`), 'dono ' + t);
  }
  for (const f of comum.SUBSTITUIDAS_108) assert.ok(comum.SQL_ESTADO.includes(`pg_has_role(current_user, proowner, 'USAGE') FROM pg_proc WHERE oid = to_regprocedure('public.${f}')`), 'dono ' + f);
  for (const f of ['kidmais_set_atualizado_em()', 'kidmais094_ocupacoes(date,date)']) assert.ok(comum.SQL_ESTADO.includes(`has_function_privilege(current_user, to_regprocedure('public.${f}'), 'EXECUTE')`), f);
  assert.match(comum.SQL_ESTADO, /has_database_privilege\(current_user, current_database\(\), 'TEMP'\) AS temp/);
  assert.match(comum.SQL_ESTADO, /has_language_privilege\(current_user, 'sql', 'USAGE'\)/);
  assert.match(comum.SQL_ESTADO, /pg_has_role\(current_user, 'pg_read_all_stats', 'USAGE'\)\) AS ver_atividade/);
  // Espelho do detector (lib/agenda/estado-combinados.ts).
  const ts = fs.readFileSync(path.join(raiz, 'lib/agenda/estado-combinados.ts'), 'utf8');
  assert.equal(/conflito098: "([0-9a-f]{64})"/.exec(ts)[1], comum.CONFLITO_098);
  assert.ok(comum.SQL_ESTADO.includes(`'${ret108.NOVA.checkMembros}'`));
  for (const [n, h] of Object.entries(ret108.NOVA.funcoes)) assert.ok(comum.SQL_ESTADO.includes(`('${n}', '${h}')`), n);
  for (const [n, , , tipo] of ret108.NOVA.gatilhos) assert.ok(comum.SQL_ESTADO.includes(`('${n}', `) && comum.SQL_ESTADO.includes(`, ${tipo}, `), n);
  for (const t of comum.TABELAS_ATIVIDADE) assert.ok(comum.SQL_ATIVIDADE.includes(`to_regclass('public.${t}')`), t);
  assert.deepEqual([...comum.TABELAS_ATIVIDADE].sort(), ['agenda_saloes', 'bloqueios_agenda', 'configuracao_agenda', 'contratos', 'fechamento_revisoes', 'fechamentos']);
  assert.match(comum.SQL_ATIVIDADE, /l\.pid IS DISTINCT FROM pg_backend_pid\(\)/);
  assert.match(comum.SQL_ATIVIDADE, /\+ count\(\*\) FILTER \(WHERE l\.pid IS NULL\)\)::int AS sem_contexto/);
  assert.match(comum.SQL_SESSOES, /backend_type = 'client backend'/);
  for (const [f] of ret108.METADADOS_108) assert.ok(comum.SQL_EXECUCAO_108.includes(`to_regprocedure('public.${f}'), 'EXECUTE'`), f);
});

test('classificação da 108 igual a classificarCombinados; estado ilegível recusa', () => {
  for (const e of ['AUSENTE', 'NOVA', 'ANTIGA', 'PARCIAL']) assert.equal(comum.lerEstado(estadoLinha({m107: 'aplicada', m108: e})).m108, e);
  for (const p of [{c_marcador: true}, {c_combinado: true}, {c_gatilhos_qualquer: 1}, {c_funcoes_qualquer: 1}]) {
    assert.equal(comum.lerEstado(estadoLinha({m107: 'aplicada', m108: 'AUSENTE'}, p)).m108, 'PARCIAL', JSON.stringify(p));
  }
  for (const p of [{c_check: false}, {c_conflito: CORPO_100}, {c_contrato: H('0')}, {c_funcoes: 9}, {c_funcoes_qualquer: 11}]) {
    assert.equal(comum.lerEstado(estadoLinha({m107: 'aplicada', m108: 'NOVA'}, p)).m108, 'PARCIAL', JSON.stringify(p));
  }
  assert.equal(comum.lerEstado(estadoLinha({m107: 'ausente', m108: 'AUSENTE'})).m107, 'ausente');
  assert.equal(comum.lerEstado(estadoLinha({m107: 'aplicada', m108: 'AUSENTE'})).m107, 'presente');
  for (const [p, re] of [[{temp: 'sim'}, /ESTADO_ILEGIVEL temp/], [{c_funcoes: -1}, /ESTADO_ILEGIVEL c_funcoes/], [{c_conflito: 'xyz'}, /ESTADO_ILEGIVEL c_conflito/],
    [{versao_pg: '18'}, /ESTADO_ILEGIVEL versao_pg/]]) assert.throws(() => comum.lerEstado(estadoLinha({m107: 'ausente', m108: 'AUSENTE'}, p)), re);
});

/**
 * MATRIZ (E4-8): estado da 107 × estado da 108 × modo → rótulo e código (e, no APLICAR, as etapas e o que foi
 * confirmado). PLANO é sempre PLANO/0 sem conexão. Esperados medidos (injetados); com os do arquivo, ver o teste seguinte.
 */
const MATRIZ = [
  // [107, 108, CONFERIR [rótulo, código, motivo], APLICAR [rótulo, código, motivo, etapas, commits]]
  ['ausente', 'AUSENTE', ['PRONTA_PARA_APLICAR', 0], ['APLICADA_POSTCHECK_PASS', 0, null, ['transacao 107', 'transacao 108'], {107: 'CONFIRMADO', 108: 'CONFIRMADO'}]],
  ['ausente', 'NOVA', ['RECUSARIA', 3, /NOVA_SEM_107/], ['FALHA', 2, /NOVA_SEM_107/, undefined, {}]],
  ['ausente', 'ANTIGA', ['RECUSARIA', 3, /COM_098_HISTORICA/], ['FALHA', 2, /COM_098_HISTORICA/, undefined, {}]],
  ['ausente', 'PARCIAL', ['RECUSARIA', 3, /APLICACAO_PARCIAL_108/], ['FALHA', 2, /APLICACAO_PARCIAL_108/, undefined, {}]],
  ['aplicada', 'AUSENTE', ['PRONTA_PARA_APLICAR', 0], ['APLICADA_POSTCHECK_PASS', 0, null, ['transacao 108'], {108: 'CONFIRMADO'}]],
  ['aplicada', 'NOVA', ['JA_APLICADA_INTEGRIDADE_PASS', 0], ['JA_APLICADA_INTEGRIDADE_PASS', 0, null, [], {}]],
  ['aplicada', 'ANTIGA', ['RECUSARIA', 3, /COM_098_HISTORICA/], ['FALHA', 2, /COM_098_HISTORICA/, undefined, {}]],
  ['aplicada', 'PARCIAL', ['RECUSARIA', 3, /APLICACAO_PARCIAL_108/], ['FALHA', 2, /APLICACAO_PARCIAL_108/, undefined, {}]],
  ['divergente', 'AUSENTE', ['RECUSARIA', 3, /INTEGRIDADE_107/], ['FALHA', 2, /INTEGRIDADE_107/, undefined, {}]],
  ['divergente', 'NOVA', ['RECUSARIA', 3, /INTEGRIDADE_107/], ['FALHA', 2, /INTEGRIDADE_107/, undefined, {}]],
  ['divergente', 'ANTIGA', ['RECUSARIA', 3, /COM_098_HISTORICA/], ['FALHA', 2, /COM_098_HISTORICA/, undefined, {}]],
  ['divergente', 'PARCIAL', ['RECUSARIA', 3, /APLICACAO_PARCIAL_108/], ['FALHA', 2, /APLICACAO_PARCIAL_108/, undefined, {}]],
];

test('matriz 107 (ausente/aplicada/divergente) × 108 (AUSENTE/NOVA/ANTIGA/PARCIAL) × modo (PLANO/CONFERIR/APLICAR)', async () => {
  assert.equal(MATRIZ.length, 12);
  for (const [m107, m108, [rc, cc, mc], [ra, ca, ma, etapas, commits]] of MATRIZ) {
    const rotulo = `${m107}×${m108}`;
    const P = await teste.principal([], ENV_TESTE, {Client: class { constructor() { throw new Error('PLANO conectou'); } }});
    assert.equal(P.codigo, 0); assert.equal(P.saida.resultado, 'PLANO');
    const Cc = clienteFalso({m107, m108});
    const c = await teste.principal([comum.FLAG_CONFERIR], ENV_TESTE, {Client: Cc});
    assert.equal(c.saida.resultado, rc, rotulo + ' CONFERIR ' + JSON.stringify(c.saida)); assert.equal(c.codigo, cc, rotulo);
    if (mc) assert.match(c.saida.motivo, mc, rotulo);
    assert.deepEqual(escritas(Cc.log), [], rotulo + ': CONFERIR não escreve');
    if (m107 === 'divergente' && /INTEGRIDADE/.test(String(mc))) assert.equal(c.saida.estado107, 'divergente');
    const dir = tmp();
    try {
      const Ca = clienteFalso({m107, m108});
      const a = await teste.principal([comum.FLAG_APLICAR, comum.FLAG_BACKUP, BACKUP, comum.FLAG_DRENAGEM, DRENAGEM], ENV_TESTE, {Client: Ca, dir, disco: semDisco});
      assert.equal(a.saida.resultado, ra, rotulo + ' APLICAR ' + JSON.stringify(a.saida)); assert.equal(a.codigo, ca, rotulo);
      if (ma) assert.match(a.saida.falha.mensagem, ma, rotulo);
      if (etapas) assert.deepEqual(a.saida.etapas, etapas, rotulo);
      assert.deepEqual(a.saida.commits, commits, rotulo);
      if (ra !== 'APLICADA_POSTCHECK_PASS') assert.deepEqual(escritas(Ca.log), [], rotulo + ': recusa/já aplicada sem escrita');
      else assert.deepEqual(corpos(Ca.log), etapas.map(e => e.slice(-3)), rotulo + ': só os corpos pendentes, na ordem');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('esperados não medidos (A_MEDIR_NO_CLUSTER, simulados): CONFERIR mede e recusa com RETRATO_NAO_MEDIDO (3); APLICAR recusa antes de conectar (1)', async () => {
  for (const [m107, m108, fase] of [['ausente', 'AUSENTE', 'F0'], ['aplicada', 'AUSENTE', 'F1'], ['aplicada', 'NOVA', 'F2']]) {
    const C = clienteFalso({m107, m108});
    const c = await comEsperadosPendentes(() => stg.principal([comum.FLAG_CONFERIR], ENV_STG, {Client: C}));
    assert.equal(c.codigo, 3, JSON.stringify(c.saida)); assert.equal(c.saida.resultado, 'RECUSARIA');
    assert.match(c.saida.motivo, new RegExp('^RETRATO_NAO_MEDIDO ' + fase + '\\.canonico'));
    if (fase !== 'F2') assert.equal(c.saida.retrato.fase, fase, 'o hash medido aparece para o registro (nunca vira referência)');
    assert.deepEqual(escritas(C.log), []);
  }
  // A conexão é conferida ANTES da mensagem: sem a guarda, a falha nomeia a causa (conectou), não um efeito do cliente falso.
  let conectou = false, erro = null;
  const Nunca = class { constructor() { conectou = true; } };
  try {
    await comEsperadosPendentes(() => stg.principal([comum.FLAG_APLICAR, comum.FLAG_BACKUP, BACKUP, comum.FLAG_DRENAGEM, DRENAGEM], ENV_STG,
      {Client: Nunca, dir: tmp(), disco: semDisco}));
  } catch (e) { erro = e; }
  assert.equal(conectou, false, 'APLICAR_CONECTOU_SEM_ESPERADOS_MEDIDOS');
  assert.match(String(erro?.message), /RETRATO_NAO_MEDIDO F0\.canonico/);
  // Override de teste recusado no staging, em TODOS os modos (antes de conectar).
  for (const argv of [[], [comum.FLAG_CONFERIR], [comum.FLAG_APLICAR, comum.FLAG_BACKUP, BACKUP, comum.FLAG_DRENAGEM, DRENAGEM]]) {
    await assert.rejects(stg.principal(argv, ENV_TESTE, {Client: Nunca, dir: tmp(), disco: semDisco}), /RETRATOS_DE_TESTE_RECUSADOS/, 'STAGING_ACEITOU_RETRATOS_DE_TESTE ' + JSON.stringify(argv));
  }
  assert.equal(conectou, false);
  assert.throws(() => stg.alvo(ENV_TESTE), /RETRATOS_DE_TESTE_RECUSADOS/, 'STAGING_ACEITOU_RETRATOS_DE_TESTE alvo');
  // Esperados injetados ilegíveis ou de outro SQL recusam.
  await assert.rejects(teste.principal([comum.FLAG_APLICAR, comum.FLAG_BACKUP, BACKUP, comum.FLAG_DRENAGEM, DRENAGEM], {...ENV_TESTE, [comum.ENV_RETRATOS_TESTE]: '{'},
    {Client: Nunca, dir: tmp(), disco: semDisco}), /RETRATOS_DE_TESTE_ILEGIVEIS/);
  await assert.rejects(teste.principal([comum.FLAG_APLICAR, comum.FLAG_BACKUP, BACKUP, comum.FLAG_DRENAGEM, DRENAGEM],
    {...ENV_TESTE, [comum.ENV_RETRATOS_TESTE]: JSON.stringify({...ESPERADOS, trecho_sha256: H('0')})}, {Client: Nunca, dir: tmp(), disco: semDisco}), /RETRATO_108_ESPERADO_DE_OUTRO_SQL/);
});

test('privilégios por fase: cada revogação individual recusa nomeada só no estado que a exige; já aplicada só pede leitura', () => {
  const p = (m, extra) => comum.exigirCatalogo(comum.lerEstado(estadoLinha(m, extra)));
  const LEITURA = {usar_public: 'USAGE_PUBLIC', plpgsql: 'PLPGSQL', ...Object.fromEntries(comum.TABELAS_LEITURA.map(t => ['ler_' + t, 'SELECT_' + t.toUpperCase()]))};
  const E107 = {pode_criar: 'CREATE', temp: 'TEMP', dono_bloqueios: 'DONO_BLOQUEIOS_AGENDA', dono_config_agenda: 'DONO_CONFIGURACAO_AGENDA',
    gatilho_bloqueios: 'TRIGGER_BLOQUEIOS_AGENDA', gatilho_config_agenda: 'TRIGGER_CONFIGURACAO_AGENDA', travar_bloqueios: 'LOCK_BLOQUEIOS_AGENDA',
    travar_config_agenda: 'LOCK_CONFIGURACAO_AGENDA', executar_set_atualizado: 'EXECUTE_KIDMAIS_SET_ATUALIZADO_EM'};
  const E108 = {linguagem_sql: 'LINGUAGEM_SQL', dono_saloes: 'DONO_AGENDA_SALOES', dono_contratos: 'DONO_CONTRATOS', dono_funcoes_108: 'DONO_FUNCOES_SUBSTITUIDAS',
    gatilho_saloes: 'TRIGGER_AGENDA_SALOES', gatilho_contratos: 'TRIGGER_CONTRATOS', travar_saloes: 'LOCK_AGENDA_SALOES', travar_contratos: 'LOCK_CONTRATOS'};
  const F0 = {m107: 'ausente', m108: 'AUSENTE'}, F1 = {m107: 'aplicada', m108: 'AUSENTE'}, F2 = {m107: 'aplicada', m108: 'NOVA'};
  for (const m of [F0, F1, F2]) {
    for (const [k, rotulo] of Object.entries(LEITURA)) assert.throws(() => p(m, {[k]: false}), new RegExp(`SEM_PRIVILEGIO_LEITURA ${rotulo}$`), k + JSON.stringify(m));
  }
  for (const [k, rotulo] of Object.entries(E107)) {
    assert.throws(() => p(F0, {[k]: false}), new RegExp(`SEM_PRIVILEGIO_107 ${rotulo}$`), k);
    if (k !== 'pode_criar') assert.doesNotThrow(() => p(F1, {[k]: false}), k + ': com a 107 presente não é exigido');
  }
  for (const [k, rotulo] of Object.entries(E108)) {
    assert.throws(() => p(F1, {[k]: false}), new RegExp(`SEM_PRIVILEGIO_108 ${rotulo}$`), k);
    assert.throws(() => p(F0, {[k]: false}), new RegExp(`SEM_PRIVILEGIO_108 ${rotulo}$`), k + ' (108 também pendente em F0)');
  }
  assert.throws(() => p(F1, {pode_criar: false}), /SEM_PRIVILEGIO_108 CREATE$/);
  assert.throws(() => p(F0, {pode_criar: false, temp: false}), /SEM_PRIVILEGIO_107 CREATE TEMP$/, 'várias faltas listadas');
  // Condicionais (P3-E4-R2-2): SELECT no registro só com ele presente; EXECUTE em kidmais094_ocupacoes só com a 108 pendente.
  assert.doesNotThrow(() => p(F0, {ler_reparos: false}), 'F0: registro ausente não exige SELECT');
  assert.throws(() => p(F1, {ler_reparos: false}), /SEM_PRIVILEGIO_LEITURA SELECT_KIDMAIS107_REPAROS$/);
  assert.throws(() => p(F2, {ler_reparos: false}), /SEM_PRIVILEGIO_LEITURA SELECT_KIDMAIS107_REPAROS$/);
  assert.throws(() => p(F1, {executar_ocupacoes: false}), /SEM_PRIVILEGIO_LEITURA EXECUTE_KIDMAIS094_OCUPACOES$/);
  assert.doesNotThrow(() => p(F2, {executar_ocupacoes: false}));
  const tudoEscrita = Object.fromEntries([...Object.keys(E107), ...Object.keys(E108), 'ver_atividade', 'executar_ocupacoes'].map(k => [k, false]));
  assert.doesNotThrow(() => p(F2, tudoEscrita), 'já aplicada: só leitura');
  assert.throws(() => p(F0, {ver_atividade: false}), /ATIVIDADE_NAO_VERIFICAVEL/);
  assert.throws(() => p(F1, {ver_atividade: false}), /ATIVIDADE_NAO_VERIFICAVEL/);
  assert.throws(() => p(F0, {versao_pg: 170005}), /PG_MAIOR_DIFERENTE 170005/);
  assert.throws(() => p(F0, {versao_pg: 190000}), /PG_MAIOR_DIFERENTE/);
  assert.throws(() => p(F0, {base107: false}), /SEM_BASE_107/);
  assert.throws(() => p(F0, {d108: false}), /SEM_DEPENDENCIA_108/);
});

test('privilégios pelo aplicador: revogação recusa antes de dados e de escrita (CONFERIR 3, APLICAR 2)', async () => {
  for (const [m, extra, re] of [[{m107: 'ausente', m108: 'AUSENTE'}, {temp: false}, /SEM_PRIVILEGIO_107 TEMP$/], [{m107: 'aplicada', m108: 'AUSENTE'}, {dono_funcoes_108: false}, /SEM_PRIVILEGIO_108 DONO_FUNCOES_SUBSTITUIDAS$/],
    [{m107: 'aplicada', m108: 'AUSENTE'}, {ler_reparos: false}, /SELECT_KIDMAIS107_REPAROS$/], [{m107: 'ausente', m108: 'AUSENTE'}, {ler_contrato_fluxos: false}, /SELECT_CONTRATO_FLUXOS$/]]) {
    const C = clienteFalso({...m, extra});
    const c = await teste.principal([comum.FLAG_CONFERIR], ENV_TESTE, {Client: C});
    assert.equal(c.codigo, 3); assert.match(c.saida.motivo, re);
    assert.ok(!C.log.some(x => x.sql === IN || x.sql === AV || x.sql === comum.SQL_ATIVIDADE), 'nada além do catálogo');
    const A = clienteFalso({...m, extra});
    const a = await aplicar(A);
    assert.equal(a.resultado, 'FALHA'); assert.match(a.falha.mensagem, re); assert.deepEqual(escritas(A.log), []);
  }
});

test('atividade: preparada/sem contexto/outra sessão recusa; ENTRE as etapas a atividade é relida e recusa antes da 108', async () => {
  assert.doesNotThrow(() => comum.exigirSemAtividade(SEM_ATIVIDADE));
  assert.throws(() => comum.exigirSemAtividade({...SEM_ATIVIDADE, locks: 2, sessoes: 1, sessoes_em_transacao: 1}), /ATIVIDADE_NAS_TABELAS 1 sessão\(ões\), 1 em transação, 2 lock\(s\)/);
  assert.throws(() => comum.exigirSemAtividade({...SEM_ATIVIDADE, locks: 1, sessoes: 1, sem_contexto: 1}), /ATIVIDADE_NAO_VERIFICAVEL 1/);
  assert.throws(() => comum.exigirSemAtividade({...SEM_ATIVIDADE, locks: 1, locks_sem_pid: 1, sem_contexto: 1}), /ATIVIDADE_NAO_VERIFICAVEL 1 sem contexto visível \(1 lock\(s\) sem pid: transação preparada\)/);
  assert.throws(() => comum.exigirSemAtividade({...SEM_ATIVIDADE, sessoes: null}), /ESTADO_ILEGIVEL atividade sessoes/);
  for (const [atividade, re] of [[{...SEM_ATIVIDADE, locks: 1, locks_sem_pid: 1, sem_contexto: 1}, /transação preparada/], [{...SEM_ATIVIDADE, locks: 1, sessoes: 1, sem_contexto: 1}, /ATIVIDADE_NAO_VERIFICAVEL 1/],
    [{...SEM_ATIVIDADE, locks: 3, sessoes: 2, sessoes_em_transacao: 1}, /ATIVIDADE_NAS_TABELAS 2/]]) {
    const C = clienteFalso({atividade});
    const c = await teste.principal([comum.FLAG_CONFERIR], ENV_TESTE, {Client: C});
    assert.equal(c.codigo, 3); assert.match(c.saida.motivo, re);
    assert.ok(!C.log.some(x => x.sql === AV || x.sql === RT), 'atividade recusa antes das verificações da fase');
    const A = clienteFalso({atividade});
    const a = await aplicar(A);
    assert.equal(a.resultado, 'FALHA'); assert.match(a.falha.mensagem, re); assert.deepEqual(escritas(A.log), []);
  }
  // Já aplicada: atividade nem é lida.
  const J = clienteFalso({m107: 'aplicada', m108: 'NOVA', atividade: {...SEM_ATIVIDADE, sessoes: 5}});
  assert.equal((await conferir(J)).resultado, 'JA_APLICADA_INTEGRIDADE_PASS'); assert.ok(!J.log.some(x => x.sql === comum.SQL_ATIVIDADE));
  // Entre as etapas: a 2ª leitura da atividade (depois do COMMIT da 107) acha outra sessão → 107 CONFIRMADO, 108 nunca começa.
  const E = clienteFalso({atividade: n => (n >= 2 ? {...SEM_ATIVIDADE, locks: 1, sessoes: 1, sessoes_em_transacao: 1} : SEM_ATIVIDADE)});
  const r = await aplicar(E);
  assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /ATIVIDADE_NAS_TABELAS 1/); assert.deepEqual(r.commits, {107: 'CONFIRMADO'});
  assert.deepEqual(corpos(E.log), ['107']); assert.ok(!E.log.some(x => x.sql === comum.SQL_LOCK['108']), 'nenhum lock da 108');
  // Sessões do banco registradas (evidência da drenagem) no CONFERIR e no APLICAR.
  assert.deepEqual((await conferir(clienteFalso())).sessoes, SESSOES);
});

test('CONFERIR só lê: READ ONLY em toda consulta, nada de BEGIN/LOCK/corpo, nada no disco; ordem catálogo → atividade → fase', async () => {
  const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
  fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
  try {
    for (const [m, fase, checks] of [[{m107: 'ausente', m108: 'AUSENTE'}, 'F0', ['avaliacao 107', 'precheck 107', 'precheck 108 pre-107', 'retrato F0']],
      [{m107: 'ausente', m108: 'AUSENTE', deriva: true}, 'F0', null], [{m107: 'aplicada', m108: 'AUSENTE'}, 'F1', ['integridade 107', 'precheck 108', 'retrato F1']],
      [{m107: 'aplicada', m108: 'NOVA'}, 'F2', ['integridade 107', 'prova 108']]]) {
      const C = clienteFalso(m);
      const r = await conferir(C);
      assert.equal(r.fase, fase); assert.equal(r.resultado, fase === 'F2' ? 'JA_APLICADA_INTEGRIDADE_PASS' : 'PRONTA_PARA_APLICAR', JSON.stringify(r));
      if (checks) assert.deepEqual(Object.keys(r.verificacoes), checks);
      if (m.deriva) { assert.equal(r.verificacoes['retrato F0'], 'deriva_conhecida'); assert.deepEqual(r.verificacoes['avaliacao 107'], {CANONICO: 0, DERIVA: 9, AUSENTE_CRIAVEL: 5}); }
      const controle = /^(BEGIN TRANSACTION READ ONLY|ROLLBACK|SET LOCAL )/;
      assert.ok(!C.log.some(x => x.sql === 'BEGIN' || x.sql === 'COMMIT' || x.sql.startsWith('LOCK')), 'sem transação de escrita');
      assert.ok(C.log.filter(x => !controle.test(x.sql)).every(x => x.ro), 'toda consulta dentro de READ ONLY');
      for (const sql of [AV, IN, RT, PV]) assert.ok(C.log.filter(x => x.sql === sql).every(x => x.caminho === 'pg_catalog'), 'construtores com search_path pg_catalog');
      for (const n of ['precheck 107', 'precheck 108 pre-107', 'precheck 108']) assert.ok(C.log.filter(x => x.sql === ARQ[n]).every(x => x.caminho === 'public, pg_catalog'), n);
      const i = s => C.log.findIndex(x => x.sql === s);
      if (fase !== 'F2') assert.ok(i(comum.SQL_ESTADO) < i(comum.SQL_ATIVIDADE) && i(comum.SQL_ATIVIDADE) < i(fase === 'F0' ? AV : RT), 'catálogo → atividade → fase');
    }
  } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
  assert.deepEqual(gravacoes, [], 'a conferência não grava arquivos');
  // Recusas das fases (com o diff por seção do retrato).
  for (const [m, re] of [[{recusa107: true}, /AVALIACAO_107_RECUSA bloqueios_agenda_periodo_check:RECUSA:DEFINICAO_DIFERENTE/], [{festaInativa: true}, /PRECHECK_108_PRE107/],
    [{retratoDiverge: true}, /RETRATO_F0_DIVERGENTE e{64}/], [{m107: 'aplicada', retratoDiverge: true}, /RETRATO_F1_DIVERGENTE/],
    [{m107: 'aplicada', festaInativa: true}, /PRECHECK_108 /], [{m107: 'aplicada', m108: 'NOVA', avaria108: true}, /INTEGRIDADE_108 MARCADOR_108 RETRATO_F2/]]) {
    const r = await conferir(clienteFalso(m));
    assert.equal(r.resultado, 'RECUSARIA', JSON.stringify(m)); assert.match(r.motivo, re);
    if (m.retratoDiverge) assert.deepEqual(Object.keys(r.retrato.secoes), ['funcoes', 'marcador_108']);
  }
});

test('APLICAR: locks na ordem fixa, revalidação da fase DENTRO de cada transação antes do corpo, verificações antes do COMMIT', async () => {
  await assert.rejects(teste.principal([comum.FLAG_APLICAR], ENV_TESTE, {Client: clienteFalso()}), /BACKUP_OBRIGATORIO/);
  await assert.rejects(teste.principal([comum.FLAG_APLICAR, comum.FLAG_BACKUP, BACKUP], ENV_TESTE, {Client: clienteFalso()}), /DRENAGEM_OBRIGATORIA/);
  await assert.rejects(teste.principal([comum.FLAG_APLICAR, comum.FLAG_BACKUP, 'x;rm', comum.FLAG_DRENAGEM, DRENAGEM], ENV_TESTE, {Client: clienteFalso()}), /BACKUP_INVALIDO/);
  await assert.rejects(teste.principal([comum.FLAG_APLICAR, comum.FLAG_BACKUP, BACKUP, comum.FLAG_DRENAGEM, 'x'], ENV_TESTE, {Client: clienteFalso()}), /DRENAGEM_INVALIDA/);
  await assert.rejects(teste.principal(['--aplicar-104-106-autorizado', comum.FLAG_BACKUP, BACKUP], ENV_TESTE, {Client: clienteFalso()}), /ARGUMENTOS_RECUSADOS/);
  assert.deepEqual(comum.TABELAS_LOCK, {107: ['bloqueios_agenda', 'configuracao_agenda'], 108: ['agenda_saloes', 'contratos']});
  assert.equal(comum.SQL_LOCK['107'], 'LOCK TABLE public.bloqueios_agenda, public.configuracao_agenda IN SHARE ROW EXCLUSIVE MODE');
  assert.equal(comum.SQL_LOCK['108'], 'LOCK TABLE public.agenda_saloes, public.contratos IN SHARE ROW EXCLUSIVE MODE');
  const dir = tmp();
  try {
    const C = clienteFalso({deriva: true});
    const r = await aplicar(C, {dir});
    assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r)); assert.deepEqual(r.commitadas, ['107', '108']);
    for (const [id, revalida, verif] of [['107', [AV, ARQ['precheck 107'], ARQ['precheck 108 pre-107'], RT], [ARQ['integridade 107']]],
      ['108', [IN, ARQ['precheck 108'], RT], [ARQ['postcheck 108'], PV, comum.SQL_EXECUCAO_108]]]) {
      const corpo = id === '107' ? C107 : C108;
      const iBegin = C.log.findIndex((x, k) => x.sql === 'BEGIN' && C.log.slice(k).some(y => y.sql === corpo) && !C.log.slice(k + 1, C.log.findIndex(y => y.sql === corpo)).some(y => y.sql === 'BEGIN'));
      const iLock = C.log.findIndex((x, k) => k > iBegin && x.sql === comum.SQL_LOCK[id]);
      const iCorpo = C.log.findIndex(x => x.sql === corpo), iCommit = C.log.findIndex((x, k) => k > iCorpo && x.sql === 'COMMIT');
      const orcamento = C.log.slice(iBegin + 1, iLock).map(x => x.sql);
      assert.deepEqual(orcamento, ["SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '120s'", "SET LOCAL idle_in_transaction_session_timeout = '60s'"], id + ': orçamento antes do lock');
      assert.ok(iBegin >= 0 && iLock > iBegin && iLock < iCorpo, id + ': BEGIN → lock → corpo');
      for (const sql of revalida) {
        const k = C.log.findIndex((x, n) => n > iLock && n < iCorpo && x.sql === sql);
        assert.ok(k > iLock && C.log[k].tx && !C.log[k].ro, id + ': revalidação na transação, depois do lock e antes do corpo');
      }
      for (const sql of verif) {
        const k = C.log.findIndex((x, n) => n > iCorpo && n < iCommit && x.sql === sql);
        assert.ok(k > iCorpo && C.log[k].tx, id + ': verificação antes do COMMIT');
      }
    }
    assert.ok(C.log.findIndex(x => x.sql === C107) < C.log.findIndex(x => x.sql === comum.SQL_LOCK['108']), '108 só depois da 107');
    // Entre as etapas: F1 relida em READ ONLY depois do COMMIT da 107 e antes do BEGIN da 108.
    const iC1 = C.log.findIndex((x, k) => k > C.log.findIndex(y => y.sql === C107) && x.sql === 'COMMIT'), iL2 = C.log.findIndex(x => x.sql === comum.SQL_LOCK['108']);
    for (const sql of [IN, ARQ['precheck 108'], RT, comum.SQL_ATIVIDADE]) assert.ok(C.log.some((x, k) => k > iC1 && k < iL2 && x.ro && x.sql === sql), 'entre as etapas');
    const m = JSON.parse(fs.readFileSync(r.marcador, 'utf8'));
    assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.backup, BACKUP); assert.equal(m.drenagem, DRENAGEM); assert.deepEqual(m.commits, {107: 'CONFIRMADO', 108: 'CONFIRMADO'});
    assert.equal(m.etapas[0].revalidacao['retrato F0'], 'deriva_conhecida');
    assert.deepEqual(m.etapas[1].antesDoCommit, {'postcheck 108': 'PASS', 'prova 108': 'PASS', 'execucao 108': 'PASS'});
    for (const id of ['107', '108']) assert.equal(JSON.parse(fs.readFileSync(path.join(dir, comum.marcadorEtapa(id)), 'utf8')).situacao, 'CONFIRMADO', 'marcador da etapa ' + id);
    assert.ok(!fs.readFileSync(r.marcador, 'utf8').includes('SENHA_FALSA'));
    await assert.rejects(aplicar(clienteFalso(), {dir}), /TENTATIVA_ANTERIOR_REVISAR/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('COMMIT por etapa: falhas antes (lock, revalidação, corpo, verificação), durante (40003/08/57/XX/sem SQLSTATE/recusa/ROLLBACK) e depois', async () => {
  const casos = [
    // Transação 1 (107).
    ['107 lock 55P03', {falharEm: comum.SQL_LOCK['107'], erro: erroPg('55P03')}, {107: 'NAO_COMMITADA'}, /55P03|erro simulado/],
    ['107 revalidação: retrato F0 diverge na transação', {falharEm: 'AS retrato) r', soNaTransacao: true}, {107: 'NAO_COMMITADA'}, /falha simulada/],
    ['107 corpo (conexão caiu)', {falharEm: 'CREATE TABLE public.kidmais107_reparos', erro: new Error('Connection terminated unexpectedly')}, {107: 'NAO_COMMITADA'}, /Connection terminated/],
    ['107 integridade antes do COMMIT', {falharEm: '107 integridade', soNaTransacao: true}, {107: 'NAO_COMMITADA'}, /INTEGRIDADE_107/],
    ['COMMIT 107 40003', {falharCommit: {n: 1, erro: erroPg('40003')}}, {107: 'INDETERMINADO'}],
    ['COMMIT 107 08006', {falharCommit: {n: 1, erro: erroPg('08006')}}, {107: 'INDETERMINADO'}],
    ['COMMIT 107 57P01', {falharCommit: {n: 1, erro: erroPg('57P01')}}, {107: 'INDETERMINADO'}],
    ['COMMIT 107 XX000', {falharCommit: {n: 1, erro: erroPg('XX000')}}, {107: 'INDETERMINADO'}],
    ['COMMIT 107 sem resposta', {falharCommit: {n: 1, erro: new Error('Connection terminated unexpectedly')}}, {107: 'INDETERMINADO'}],
    ['COMMIT 107 recusado 23514', {falharCommit: {n: 1, erro: erroPg('23514')}}, {107: 'DESFEITA_PELO_SERVIDOR'}],
    ['COMMIT 107 respondido como ROLLBACK', {falharCommit: {n: 1, rollback: true}}, {107: 'DESFEITA_PELO_SERVIDOR'}, /COMMIT_RESPONDIDO_COMO_ROLLBACK_107/],
    ['depois do COMMIT 107: estado não mudou', {naoCompleta: '107'}, {107: 'CONFIRMADO'}, /ESTADO_DEPOIS_107/],
    // Transação 2 (108), com a 107 confirmada.
    ['108 lock 55P03', {falharEm: comum.SQL_LOCK['108'], erro: erroPg('55P03')}, {107: 'CONFIRMADO', 108: 'NAO_COMMITADA'}],
    ['108 corpo', {falharEm: 'CREATE FUNCTION public.kidmais098_hoje()', erro: erroPg('42P07')}, {107: 'CONFIRMADO', 108: 'NAO_COMMITADA'}],
    ['108 postcheck', {falharEm: '108 postcheck', soNaTransacao: true}, {107: 'CONFIRMADO', 108: 'NAO_COMMITADA'}, /POSTCHECK_108/],
    ['108 sem EXECUTE', {executa: false}, {107: 'CONFIRMADO', 108: 'NAO_COMMITADA'}, /EXECUCAO_FUNCOES_108/],
    ['COMMIT 108 40003', {falharCommit: {n: 2, erro: erroPg('40003')}}, {107: 'CONFIRMADO', 108: 'INDETERMINADO'}],
    ['COMMIT 108 respondido como ROLLBACK', {falharCommit: {n: 2, rollback: true}}, {107: 'CONFIRMADO', 108: 'DESFEITA_PELO_SERVIDOR'}, /COMMIT_RESPONDIDO_COMO_ROLLBACK_108/],
    ['depois do COMMIT 108: prova falha (F2)', {avariaDepois: true}, {107: 'CONFIRMADO', 108: 'CONFIRMADO'}, /INTEGRIDADE_108/],
    ['depois do COMMIT 108: estado não mudou', {naoCompleta: '108'}, {107: 'CONFIRMADO', 108: 'CONFIRMADO'}, /ESTADO_DEPOIS_108/],
  ];
  for (const [rotulo, opcoes, commits, re] of casos) {
    const dir = tmp();
    try {
      const C = clienteFalso(opcoes);
      const r = await aplicar(C, {dir});
      assert.equal(r.resultado, 'FALHA', rotulo + JSON.stringify(r)); assert.deepEqual(r.commits, commits, rotulo);
      if (re) assert.match(r.falha.mensagem, re, rotulo);
      assert.match(r.reconciliar, /--conferir-107-108/);
      const m = JSON.parse(fs.readFileSync(r.marcador, 'utf8'));
      assert.equal(m.situacao, 'FALHA'); assert.deepEqual(m.commits, commits, rotulo + ' (marcador)');
      if (!('108' in commits)) assert.ok(!C.log.some(x => x.sql === comum.SQL_LOCK['108']), rotulo + ': 108 não começa');
      for (const [id, situacao] of Object.entries(commits)) {
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, comum.marcadorEtapa(id)), 'utf8')).situacao, situacao, rotulo + ': marcador da etapa ' + id);
      }
      const commitsEnviados = C.log.filter(x => x.sql === 'COMMIT').length;
      assert.ok(commitsEnviados <= Object.keys(commits).length, rotulo + ': nenhum COMMIT a mais');
      if (commits['107'] === 'NAO_COMMITADA') assert.equal(commitsEnviados, 0, rotulo + ': COMMIT nunca enviado');
      await assert.rejects(teste.principal([comum.FLAG_APLICAR, comum.FLAG_BACKUP, BACKUP, comum.FLAG_DRENAGEM, DRENAGEM], ENV_TESTE, {Client: clienteFalso(), dir, disco: semDisco}),
        /TENTATIVA_ANTERIOR_REVISAR/, rotulo + ': marcador impede a repetição');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
  for (const [e, esperado] of [[erroPg('40003'), 'INDETERMINADO'], [erroPg('57014'), 'INDETERMINADO'], [erroPg('08006'), 'INDETERMINADO'], [erroPg('58030'), 'INDETERMINADO'],
    [erroPg('XX000'), 'INDETERMINADO'], [new Error('sem código'), 'INDETERMINADO'], [erroPg('23503'), 'DESFEITA_PELO_SERVIDOR'], [erroPg('40001'), 'DESFEITA_PELO_SERVIDOR']]) {
    assert.equal(comum.commitNaFalha(e), esperado, String(e.code ?? e.message));
  }
});

test('retomada: só a 108 com a 107 aplicada e íntegra; marcador de etapa exige revisão; INDETERMINADO nunca reaplica sozinho', async () => {
  const dir = tmp();
  try {
    const C1 = clienteFalso({falharEm: comum.SQL_LOCK['108'], erro: erroPg('55P03')});
    const r1 = await aplicar(C1, {dir});
    assert.deepEqual(r1.commits, {107: 'CONFIRMADO', 108: 'NAO_COMMITADA'});
    // Só o marcador da execução renomeado: a etapa 108 já tentada recusa, sem escrita.
    fs.renameSync(path.join(dir, comum.MARCADOR), path.join(dir, 'migration-107-108.2026-10-29T22-00.json'));
    const C2 = clienteFalso({m107: 'aplicada'});
    const r2 = await aplicar(C2, {dir});
    assert.equal(r2.resultado, 'FALHA'); assert.match(r2.falha.mensagem, /ETAPA_JA_TENTADA_REVISAR 108/); assert.deepEqual(escritas(C2.log), []);
    // Revisado: os dois marcadores renomeados (nunca apagados) → só a 108.
    fs.renameSync(path.join(dir, comum.MARCADOR), path.join(dir, 'migration-107-108.2026-10-29T22-10.json'));
    fs.renameSync(path.join(dir, comum.marcadorEtapa('108')), path.join(dir, 'migration-107-108.etapa-108.2026-10-29T22-10.json'));
    const C3 = clienteFalso({m107: 'aplicada'});
    const r3 = await aplicar(C3, {dir});
    assert.equal(r3.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r3)); assert.deepEqual(r3.etapas, ['transacao 108']); assert.deepEqual(r3.commits, {108: 'CONFIRMADO'});
    assert.deepEqual(corpos(C3.log), ['108']);
    const m = JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8'));
    assert.ok(m.tentativasAnteriores.includes('migration-107-108.etapa-108.2026-10-29T22-10.json') && m.tentativasAnteriores.includes(comum.marcadorEtapa('107')));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  // COMMIT da 107 INDETERMINADO e o banco sem a 107: com o marcador da execução renomeado, a etapa 107 continua travada.
  const d2 = tmp();
  try {
    const r = await aplicar(clienteFalso({falharCommit: {n: 1, erro: erroPg('08006')}}), {dir: d2});
    assert.deepEqual(r.commits, {107: 'INDETERMINADO'});
    fs.renameSync(path.join(d2, comum.MARCADOR), path.join(d2, 'migration-107-108.2026-10-29T23-00.json'));
    const C = clienteFalso();
    const x = await aplicar(C, {dir: d2});
    assert.equal(x.resultado, 'FALHA'); assert.match(x.falha.mensagem, /ETAPA_JA_TENTADA_REVISAR 107/); assert.deepEqual(escritas(C.log), [], 'nunca reaplica sozinho');
  } finally { fs.rmSync(d2, {recursive: true, force: true}); }
});

test('marcador: existente (mesmo ilegível), diretório ilegível, sem permissão na criação e gravação falhando antes/depois do COMMIT', async () => {
  const argv = [comum.FLAG_APLICAR, comum.FLAG_BACKUP, BACKUP, comum.FLAG_DRENAGEM, DRENAGEM];
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, comum.MARCADOR), '{ilegível');
    let conectou = false;
    await assert.rejects(teste.principal(argv, ENV_TESTE, {Client: class { constructor() { conectou = true; } }, dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
    assert.equal(conectou, false, 'recusa antes de conectar (código 1 na CLI)');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  const comFs = sobrescrever => Object.assign(Object.create(fs), sobrescrever);
  const eacces = () => { throw Object.assign(new Error('EACCES: permission denied'), {code: 'EACCES'}); };
  for (const [rotulo, fsx, re] of [
    ['diretório ilegível', comFs({readdirSync: eacces}), /MARCADOR_ILEGIVEL EACCES/],
    ['sem permissão no diretório', comFs({mkdirSync: eacces}), /MARCADOR_SEM_PERMISSAO EACCES/],
    ['sem permissão no marcador', comFs({writeFileSync: (p, ...a) => (String(p).endsWith(comum.MARCADOR) ? eacces() : fs.writeFileSync(p, ...a))}), /MARCADOR_SEM_PERMISSAO EACCES/]]) {
    const d = tmp();
    try {
      let conectou = false;
      await assert.rejects(teste.principal(argv, ENV_TESTE, {Client: class { constructor() { conectou = true; } }, dir: d, disco: semDisco, fsx}), re, rotulo);
      assert.equal(conectou, false, rotulo);
    } finally { fs.rmSync(d, {recursive: true, force: true}); }
  }
  // Gravação do marcador falha no registro ANTES do COMMIT da 107: nada confirmado, COMMIT nunca enviado.
  for (const [rotulo, quando, commits, nCommits] of [['antes do COMMIT da 107', s => s.includes('"antesDoCommit"') && !s.includes('"commit"'), {107: 'NAO_COMMITADA'}, 0],
    ['depois do COMMIT da 107', s => s.includes('"commit": "CONFIRMADO"'), {107: 'CONFIRMADO'}, 1]]) {
    const d = tmp();
    try {
      let quebrado = false;
      const fsx = comFs({writeFileSync: (p, dados, ...a) => {
        if (!quebrado && String(p).endsWith(comum.MARCADOR) && quando(String(dados))) quebrado = true;
        if (quebrado && String(p).endsWith(comum.MARCADOR)) eacces();
        return fs.writeFileSync(p, dados, ...a);
      }});
      const C = clienteFalso();
      const r = await aplicar(C, {dir: d, fsx});
      assert.equal(r.resultado, 'FALHA', rotulo); assert.equal(r.marcadorGravado, false, rotulo);
      assert.equal(C.log.filter(x => x.sql === 'COMMIT').length, nCommits, rotulo);
      assert.deepEqual(r.commits, commits, rotulo);
      assert.ok(!C.log.some(x => x.sql === comum.SQL_LOCK['108']), rotulo + ': a 108 não começa');
    } finally { fs.rmSync(d, {recursive: true, force: true}); }
  }
  await assert.rejects(aplicar(clienteFalso(), {disco: () => assert.fail('DISCO_PERSISTENTE_AUSENTE')}), /DISCO_PERSISTENTE_AUSENTE/);
});

test('trava de alvo de staging e identidade; mensagem sem segredos', async () => {
  assert.equal(stg.alvo(ENV_STG).application_name, 'kidmais-migration-107-108-staging');
  for (const [mudanca, erro] of [[{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg'}, /SERVICO_RECUSADO/], [{KIDMAIS_DEPLOY_ENV: 'production'}, /AMBIENTE_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace('dpg-daidko3m8hqs73ce4jt0-a', 'dpg-outro.render.com')}, /HOST_RECUSADO/], [{DATABASE_URL: URL_STG.replace('kidmais_staging_1z91', 'kidmais_manager')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace(':5432', ':5433')}, /PORTA_RECUSADA/], [{DATABASE_URL: URL_STG + '?sslmode=disable'}, /CONNECTION_QUERY_REJECTED/], [{DATABASE_SSL: 'talvez'}, /TLS_CONFIGURACAO_RECUSADA/]]) {
    assert.throws(() => stg.alvo({...ENV_STG, ...mudanca}), (e) => erro.test(e.message) && !e.message.includes('SENHA_FALSA'));
  }
  const outro = await conferir(clienteFalso({identidade: {...ID_STG, db: 'outro_banco'}}));
  assert.equal(outro.resultado, 'FALHA'); assert.ok(!JSON.stringify(outro).includes('SENHA_FALSA'));
  assert.equal(stg.DIR, '/opt/render/project/src/data/saloes-107-108-staging');
  await assert.rejects(stg.principal([comum.FLAG_CONFERIR], {...ENV_STG, RENDER_SERVICE_ID: 'srv-x'}, {Client: clienteFalso()}), /SERVICO_RECUSADO/);
});

test('PLANO sem conexão (conector que falha): arquivos e downs com sha, retratos medidos (e não medidos simulados), fases, locks, orçamento, drenagem, recuperação', async () => {
  let construido = false;
  const Falha = class { constructor() { construido = true; throw new Error('PLANO conectou'); } };
  const {codigo, saida} = await stg.principal([], {}, {Client: Falha});
  assert.equal(codigo, 0); assert.equal(construido, false); assert.equal(saida.conecta, false); assert.equal(saida.ambiente, 'staging');
  assert.deepEqual(saida.arquivos.map(a => a.sha256), comum.ARQUIVOS.map(e => e[2]));
  assert.deepEqual(saida.recuperacaoArquivos.map(a => a.nome), ['down 108', 'down 107']);
  assert.deepEqual(saida.retratos, {F0: ['canonico', 'deriva_conhecida'], F1: ['canonico'], F2: ['canonico']}, 'arquivo versionado medido');
  const pendente = (await comEsperadosPendentes(() => stg.principal([], {}, {Client: Falha}))).saida;
  for (const f of ['F0', 'F1', 'F2']) assert.match(pendente.retratos[f], /^RETRATO_NAO_MEDIDO /);
  assert.deepEqual((await teste.principal([], ENV_TESTE, {Client: Falha})).saida.retratos, {F0: ['canonico', 'deriva_conhecida'], F1: ['canonico'], F2: ['canonico']});
  assert.deepEqual(saida.transacoes.map(t => [t.id, t.locks, t.revalida]), [['107', ['public.bloqueios_agenda', 'public.configuracao_agenda'], 'F0'],
    ['108', ['public.agenda_saloes', 'public.contratos'], 'F1']]);
  assert.equal(saida.orcamento.lock_timeout, '5s'); assert.equal(saida.orcamento.statement_timeout, '120s');
  assert.ok(saida.ordem.some(o => /drenada/.test(o) && /job\/shell do Render/.test(o) && /DDL/.test(o)));
  assert.ok(saida.ordem.some(o => /PITR/.test(o) && /NÃO substitui/.test(o)));
  assert.ok(saida.recuperacao.some(r => /down da 108 ANTES do down da 107/.test(r)) && saida.recuperacao.some(r => /E2a/.test(r)));
  assert.ok(saida.paradas.some(p => /INDETERMINADO/.test(p)) && saida.paradas.some(p => /nunca apagar/.test(p)));
  for (const n of ['down 107', 'down 108', 'ligar SALOES_PUBLICOS']) assert.ok(saida.nuncaExecuta.includes(n), n);
  assert.match(saida.modos.aplicar, /--drenagem/);
});
