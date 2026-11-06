/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 114 (trava da configuração nos gatilhos da 019, staging) com cliente simulado que só CONFIRMA no COMMIT e descarta
// no ROLLBACK: hash do SQL, estado pela função nova e pelos corpos (ausente/presente/divergente), gatilhos, privilégios um a um,
// trava de alvo, conferência só leitura, migration sem o COMMIT final com estado, preservação e prova funcional na transação,
// situação do COMMIT (NAO_COMMITADA / CONFIRMADO / DESFEITA_PELO_SERVIDOR / INDETERMINADO), marcador anti-repetição e retomada.
// Sem rede nem banco (a prova real é lib/agenda/aplicador-114.postgres.test.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const comum = require('./migration-114-comum.cjs');
const stg = require('./migration-114-staging.cjs');
const {lerRevisado} = require('./migration-092-094-comum.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_STG = 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91';
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false', DATABASE_URL: URL_STG});
const ID_STG = {db: 'kidmais_staging_1z91', tls: false, servidor_privado: true};
const BACKUP = 'PITR 2026-11-05T22:00Z staging';
const [, ARQ, HASH] = comum.ETAPAS[0];
const M114 = lerRevisado(raiz, ARQ, HASH);
const CORPO = comum.semCommitFinal(M114, 'm');
const erroPg = (code, msg = 'erro simulado') => Object.assign(new Error(msg), {code, severity: 'ERROR'});
const erroNode = (code, syscall = 'write') => Object.assign(new Error(code + ' simulado'), {code, errno: -32, syscall});
const TODOS = comum.GATILHOS.map(g => g[0]);
const ZERO = Object.freeze(comum.PRESERVADAS.map((tabela, i) => ({tabela, arquivo: String(1000 + i), escritas: 0})));
const ESPERADOS = comum.GATILHOS_ESPERADOS;
const linhaCom = (t, muda) => ZERO.map(l => (l.tabela === t ? {...l, ...muda} : l));
const base = (aplicada, extra = {}) => ({versao_pg: 180006, tabelas: 4, f114: aplicada,
  hash_lock: aplicada ? comum.CORPOS.depois.lock : comum.CORPOS.antes.lock, hash_revisao: aplicada ? comum.CORPOS.depois.revisao : comum.CORPOS.antes.revisao,
  hash_exigir: aplicada ? comum.HASH_EXIGIR : null, atributos_exigir: aplicada ? comum.ATRIBUTOS.exigir : null,
  atributos_lock: comum.ATRIBUTOS.lock, atributos_revisao: comum.ATRIBUTOS.revisao, contagem_ligada: true,
  gatilhos: ESPERADOS, dono_lock: true, dono_revisao: true, execute_publico: aplicada, ler_tabelas: true, usar_public: true, pode_criar: true, plpgsql: true, papel_trocado: true, ...extra});

/**
 * Cliente simulado transacional: o corpo da migration deixa a 114 PENDENTE; 'COMMIT' confirma; 'ROLLBACK' descarta. Opções:
 * aplicada (inicial), extra (campos do estado), falharEm (trecho → `erro`), falharCommit ({erro} ou {rollback: true}),
 * preservacao (o que a prova devolve), naTransacao (campos do estado dentro da transação), semKd114 (exigir sem trava não
 * lança), kdOutro (código do erro sem a trava), semUsage, depoisDoCommit (campos do estado depois do COMMIT).
 */
function clienteFalso({aplicada = false, extra, falharEm, erro, falharCommit, preservacao, naTransacao, semKd114, kdOutro, aceitaOutraEmpresa, aceitaOutraChave, acumulado, semUsage, depoisDoCommit, identidade = ID_STG} = {}) {
  const log = []; let ro = false, pendente = false, commits = 0, travada = null, outraChave = false;
  const atual = {aplicada, confirmado: false};
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql, params) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') ro = true;
      log.push({sql, ro, emTransacao: pendente, params});
      if (falharEm && sql.includes(falharEm)) throw erro ?? erroPg('55P03', 'falha simulada');
      if (sql === 'ROLLBACK') { ro = false; pendente = false; travada = null; outraChave = false; return {rows: [], command: 'ROLLBACK'}; }
      if (sql === 'COMMIT') {
        commits++;
        if (falharCommit?.rollback) { pendente = false; return {rows: [], command: 'ROLLBACK'}; }
        if (falharCommit?.erro) throw falharCommit.erro;
        if (pendente) { atual.aplicada = true; atual.confirmado = true; }
        pendente = false; travada = null; outraChave = false; return {rows: [], command: 'COMMIT'};
      }
      if (sql === CORPO) { assert.equal(ro, false, 'migration fora de READ ONLY'); pendente = true; return {rows: []}; }
      if (sql === comum.SQL_USAGE_PUBLIC) return {rows: [{usar_public: !semUsage}]};
      if (sql === stg.SQL_IDENTIDADE) return {rows: [identidade]};
      if (sql === comum.SQL_ESTADO) {
        if (pendente) return {rows: [{...base(true, extra), ...naTransacao}]};
        return {rows: [{...base(atual.aplicada, extra), ...(atual.confirmado ? depoisDoCommit : {})}]};
      }
      if (sql === comum.SQL_PRESERVACAO) return {rows: pendente && preservacao ? preservacao : acumulado ?? ZERO};
      if (sql === comum.SQL_TRAVAR) { travada = params[0]; return {rows: []}; }
      if (sql === comum.SQL_TRAVAR_OUTRA_CHAVE) { outraChave = true; return {rows: []}; }
      if (sql === 'ROLLBACK TO SAVEPOINT prova_114') { travada = null; outraChave = false; return {rows: []}; }
      if (sql === comum.SQL_EXIGIR) {
        const passa = params[0] === null || semKd114 || travada === params[0] || (aceitaOutraEmpresa && travada) || (aceitaOutraChave && outraChave);
        if (!passa) throw erroPg(kdOutro ?? 'KD114', 'sem trava');
        return {rows: []};
      }
      return {rows: [], command: 'SET'};
    }
  };
  return {C, log, atual, commits: () => commits};
}
const pasta = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-114-'));
const executar = (f, dir = pasta()) => stg.executar({env: ENV_STG, backup: BACKUP, dir, raiz, disco: () => {}, Client: f.C});
const conferir = f => stg.conferir({env: ENV_STG, Client: f.C});
const marcador = d => JSON.parse(fs.readFileSync(path.join(d, comum.MARCADOR), 'utf8'));

test('hash do SQL, moldura de uma transação, CRLF normalizado, plano sem conexão e nunca o down', () => {
  assert.throws(() => lerRevisado(raiz, ARQ, 'f'.repeat(64)), /ARQUIVO_DIVERGENTE/);
  assert.throws(() => comum.semCommitFinal(M114 + '-- x\n', 'm'), /TRANSACAO_INESPERADA/);
  assert.throws(() => comum.semCommitFinal('BEGIN;\nBEGIN;\nCOMMIT;\n', 'm'), /TRANSACAO_INESPERADA/);
  const p = stg.plano();
  assert.equal(p.conecta, false); assert.equal(p.alvo.servico, ENV_STG.RENDER_SERVICE_ID);
  assert.ok(p.nuncaExecuta.includes('down 114') && p.nuncaExecuta.includes('ligar AGENDA_MAIS_DE_UM_SALAO'));
  // Os hashes do aplicador são os do precheck e do postcheck do próprio SQL e do down.
  const down = fs.readFileSync(path.join(raiz, 'database/rollback/20261031_114_trava_configuracao_gatilhos_down.sql'), 'utf8');
  for (const h of Object.values(comum.CORPOS.antes)) assert.ok(M114.includes(h), h);
  for (const h of Object.values(comum.CORPOS.depois)) { assert.ok(M114.includes(h), h); assert.ok(down.includes(h), h); }
  // Listas literais: tirar uma tabela ou um gatilho do núcleo reprova aqui.
  assert.deepEqual([...comum.PRESERVADAS], ['fechamentos', 'contratos', 'contrato_fluxos', 'fechamento_revisoes']);
  assert.deepEqual(comum.GATILHOS.map(g => g.join(' ')), [
    'festa019_lock_fechamento fechamentos kidmais019_lock_ocupacao() 23 false', 'festa019_lock_contrato contratos kidmais019_lock_ocupacao() 23 false',
    'festa019_lock_fluxo contrato_fluxos kidmais019_lock_ocupacao() 23 false', 'festa019_lock_revisao fechamento_revisoes kidmais019_lock_ocupacao() 23 false',
    'fr_agenda_validar_trg fechamento_revisoes kidmais_validar_agenda_revisao() 21 true', 'fr_confirmacao_agenda_trg fechamentos kidmais_validar_agenda_revisao() 21 true']);
  assert.equal(comum.GATILHOS_ESPERADOS[0], 'festa019_lock_fechamento:true:23::true:false:false:false:0');
  assert.equal(comum.GATILHOS_ESPERADOS[5], 'fr_confirmacao_agenda_trg:true:21::true:true:true:true:0');
  assert.equal(comum.HASH_EXIGIR, '0f0f6a4a61700d49a31aa411f7ae2a28111fb91d82637e5f88a13edf464a6149');
  assert.deepEqual({...comum.ATRIBUTOS}, {exigir: 'plpgsql:false:s:false:void:search_path=public, pg_catalog', lock: 'plpgsql:false:v:false:trigger:search_path=public, pg_catalog', revisao: 'plpgsql:false:v:false:trigger:'});
});

test('estado: ausente, presente e divergente em cada combinação; valores ilegíveis recusam', () => {
  assert.equal(comum.lerEstado(base(false)).m114, 'ausente');
  assert.equal(comum.lerEstado(base(true)).m114, 'presente');
  for (const [nome, extra] of [
    ['corpos novos sem a função', {hash_lock: comum.CORPOS.depois.lock, hash_revisao: comum.CORPOS.depois.revisao}],
    ['tudo da 114 menos a função', {hash_lock: comum.CORPOS.depois.lock, hash_revisao: comum.CORPOS.depois.revisao, hash_exigir: comum.HASH_EXIGIR, atributos_exigir: comum.ATRIBUTOS.exigir}],
    ['função sem corpos novos', {f114: true, hash_lock: comum.CORPOS.antes.lock, hash_revisao: comum.CORPOS.antes.revisao}],
    ['um corpo só trocado', {hash_lock: comum.CORPOS.depois.lock}],
    ['outro corpo só trocado', {hash_revisao: comum.CORPOS.depois.revisao}],
    ['corpo desconhecido (098)', {hash_revisao: 'a'.repeat(64)}],
    ['função removida', {hash_lock: null}],
  ]) {
    const s = comum.lerEstado(base(false, extra));
    assert.equal(s.m114, 'divergente', nome);
    assert.throws(() => comum.planoEtapas(s), /CORPOS_DIVERGENTES_114/, nome);
  }
  const d = comum.lerEstado(base(false, {hash_revisao: 'a'.repeat(64)}));
  assert.equal(d.corpos.revisao, 'aaaaaaaa'); assert.equal(d.corpos.lock, comum.CORPOS.antes.lock.slice(0, 8));
  const q = comum.lerEstado(base(true, {hash_lock: comum.CORPOS.antes.lock}));
  assert.equal(q.m114, 'divergente');
  // Função nova: corpo autenticado por hash e atributos das 3 funções.
  for (const [nome, extra, re] of [
    ['corpo da função nova trocado', {hash_exigir: 'c'.repeat(64)}, /exigir=cccccccc/],
    ['função nova sem corpo legível', {hash_exigir: null}, /exigir=ausente/],
    ['função nova SECURITY DEFINER', {atributos_exigir: comum.ATRIBUTOS.exigir.replace(':false:s', ':true:s')}, /atributos=exigir/],
    ['função nova STRICT', {atributos_exigir: 'plpgsql:false:s:true:void:search_path=public, pg_catalog'}, /atributos=exigir/],
    ['função nova sem search_path', {atributos_exigir: 'plpgsql:false:s:false:void:'}, /atributos=exigir/],
    ['gatilho de lock com outro atributo', {atributos_lock: 'plpgsql:true:v:false:trigger:search_path=public, pg_catalog'}, /atributos=lock/],
    ['gatilho de revisão com outro atributo', {atributos_revisao: 'plpgsql:false:v:false:trigger:x=y'}, /atributos=revisao/],
  ]) {
    const s = comum.lerEstado(base(true, extra));
    assert.equal(s.m114, 'divergente', nome);
    assert.throws(() => comum.planoEtapas(s), re, nome);
  }
  // Sem a função nova, os atributos antigos não importam: a própria 114 os substitui.
  assert.equal(comum.lerEstado(base(false, {atributos_lock: 'plpgsql:true:v:false:trigger:'})).m114, 'ausente');
  for (const extra of [{f114: 'sim'}, {versao_pg: null}, {tabelas: 9}, {hash_lock: 'nao-hex'}, {hash_exigir: 'nao-hex'}, {atributos_lock: 1}, {gatilhos: 'x'}, {usar_public: null}, {contagem_ligada: null}])
    assert.throws(() => comum.lerEstado(base(false, extra)), /ESTADO_ILEGIVEL/, JSON.stringify(extra));
});

test('guardas: tabela, leitura, gatilho e privilégios recusam pelo nome; os planos por estado', () => {
  assert.deepEqual(comum.planoEtapas(comum.lerEstado(base(false))), ['migration 114']);
  assert.deepEqual(comum.planoEtapas(comum.lerEstado(base(true))), []);
  for (const [extra, re] of [
    [{tabelas: 3}, /TABELA_AUSENTE/], [{ler_tabelas: false}, /SEM_PRIVILEGIO_LEITURA SELECT_TABELAS/], [{usar_public: false}, /SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC/],
    [{dono_lock: false}, /SEM_PRIVILEGIO_114 DONO_LOCK/], [{dono_revisao: false}, /SEM_PRIVILEGIO_114 DONO_REVISAO/], [{pode_criar: false}, /SEM_PRIVILEGIO_114 CREATE/], [{plpgsql: false}, /SEM_PRIVILEGIO_114 LINGUAGEM/],
  ]) assert.throws(() => comum.planoEtapas(comum.lerEstado(base(false, extra))), re, JSON.stringify(extra));
  for (const g of ESPERADOS) {
    const nome = g.split(':')[0];
    assert.throws(() => comum.planoEtapas(comum.lerEstado(base(false, {gatilhos: ESPERADOS.filter(x => x !== g)}))), new RegExp('GATILHO_DIVERGENTE_114 ' + nome));
    // Mesmo nome, tabela e função, mas sem proteger a escrita normal: ENABLE REPLICA ou desligado, outro tipo, colunas, WHEN, adiamento, argumentos.
    const [n, , tipo, , , d, i, cons, nargs] = g.split(':');
    for (const ruim of [`${n}:false:${tipo}::true:${d}:${i}:${cons}:${nargs}`, `${n}:true:7::true:${d}:${i}:${cons}:${nargs}`, `${n}:true:${tipo}:3:true:${d}:${i}:${cons}:${nargs}`,
      `${n}:true:${tipo}::false:${d}:${i}:${cons}:${nargs}`, `${n}:true:${tipo}::true:${d === 'true' ? 'false' : 'true'}:${i}:${cons}:${nargs}`,
      `${n}:true:${tipo}::true:${d}:${i === 'true' ? 'false' : 'true'}:${cons}:${nargs}`, `${n}:true:${tipo}::true:${d}:${i}:${cons === 'true' ? 'false' : 'true'}:${nargs}`, `${n}:true:${tipo}::true:${d}:${i}:${cons}:1`])
      assert.throws(() => comum.planoEtapas(comum.lerEstado(base(false, {gatilhos: ESPERADOS.map(x => (x === g ? ruim : x))}))), new RegExp('GATILHO_DIVERGENTE_114 ' + nome), ruim);
  }
  assert.throws(() => comum.planoEtapas(comum.lerEstado(base(false, {contagem_ligada: false}))), /CONTAGEM_DESLIGADA_114/);
  assert.throws(() => comum.planoEtapas(comum.lerEstado(base(true, {execute_publico: false}))), /EXECUTE_RESTRITO_114/);
  // Presente não exige ser dono (a aplicação já aconteceu).
  assert.deepEqual(comum.planoEtapas(comum.lerEstado(base(true, {dono_lock: false, dono_revisao: false, pode_criar: false}))), []);
});

test('SQL do estado: só catálogo, os 6 gatilhos e EXECUTE para PUBLIC; preservação nas 4 tabelas', () => {
  assert.doesNotMatch(comum.SQL_ESTADO, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\s/);
  for (const t of comum.PRESERVADAS) assert.doesNotMatch(comum.SQL_ESTADO, new RegExp('FROM\\s+(public\\.)?' + t + '\\b'), t);
  for (const g of TODOS) assert.ok(comum.SQL_ESTADO.includes(`'${g}'`), g);
  assert.match(comum.SQL_ESTADO, /has_function_privilege\('public'/);
  assert.doesNotMatch(comum.SQL_ESTADO, /tgenabled <> 'D'/);
  assert.match(comum.SQL_ESTADO, /tgenabled IN \('O','A'\)/);
  assert.match(comum.SQL_ESTADO, /current_setting\('track_counts'\)/);
  for (const col of ['tgtype', 'tgattr', 'tgqual', 'tgdeferrable', 'tginitdeferred', 'tgconstraint', 'tgnargs']) assert.ok(comum.SQL_ESTADO.includes('x.' + col), col);
  for (const col of ['prosecdef', 'provolatile', 'proisstrict', 'prorettype', 'proconfig', 'lanname']) assert.ok(comum.SQL_ESTADO.includes(col), col);
  for (const t of comum.PRESERVADAS) assert.ok(comum.SQL_PRESERVACAO.includes(`to_regclass('public.${t}')`), t);
  for (const c of ['inserted', 'updated', 'deleted']) assert.ok(comum.SQL_PRESERVACAO.includes(`pg_stat_get_xact_tuples_${c}`), c);
  assert.match(comum.SQL_PRESERVACAO, /relfilenode/);
  assert.doesNotMatch(comum.SQL_PRESERVACAO, /xmin/);
});

test('trava de alvo: fora do Render, outro serviço, outro ambiente, outro banco, outro host e URL com parâmetros recusam antes de conectar', async () => {
  for (const [muda, re] of [[{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg'}, /SERVICO_RECUSADO/], [{KIDMAIS_DEPLOY_ENV: 'production'}, /AMBIENTE_RECUSADO/],
    [{DATABASE_URL: 'nao-url'}, /URL_RECUSADA/], [{DATABASE_URL: URL_STG.replace('kidmais_staging_1z91', 'kidmais_manager')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace('dpg-daidko3m8hqs73ce4jt0-a', 'outro-host')}, /HOST_RECUSADO/], [{DATABASE_URL: URL_STG + '?sslmode=disable'}, /CONNECTION_QUERY_REJECTED/]]) {
    const env = {...ENV_STG, ...muda};
    const f = clienteFalso();
    await assert.rejects(() => stg.conferir({env, Client: f.C}), re);
    const d = pasta();
    await assert.rejects(() => stg.executar({env, backup: BACKUP, dir: d, raiz, disco: () => {}, Client: f.C}), re);
    assert.deepEqual(fs.readdirSync(d), [], 'sem marcador');
    assert.equal(f.log.length, 0, 'sem conexão');
  }
});

test('argumentos: plano, conferir e aplicar exigem exatamente a forma; backup obrigatório', async () => {
  assert.deepEqual(comum.modo([]), {modo: 'plano'});
  assert.deepEqual(comum.modo(['--conferir-114']), {modo: 'conferir'});
  assert.deepEqual(comum.modo(['--aplicar-114-autorizado', '--backup', BACKUP]), {modo: 'aplicar', backup: BACKUP});
  assert.throws(() => comum.modo(['--aplicar-114-autorizado']), /BACKUP_OBRIGATORIO/);
  assert.throws(() => comum.modo(['--aplicar-114-autorizado', '--backup', 'x;rm']), /BACKUP_INVALIDO/);
  assert.throws(() => comum.modo(['--conferir-117']), /ARGUMENTOS_RECUSADOS/);
  assert.throws(() => comum.modo(['--conferir-114', '--aplicar-114-autorizado']), /BACKUP_OBRIGATORIO/);
  assert.equal((await stg.principal([], ENV_STG)).codigo, 0);
  await assert.rejects(() => stg.executar({env: ENV_STG, backup: '', dir: pasta(), raiz, disco: () => {}, Client: clienteFalso().C}), /BACKUP_OBRIGATORIO/);
});

test('conferência ausente: PRONTA_PARA_APLICAR, só leitura, sem marcador e sem a migration', async () => {
  const f = clienteFalso();
  const r = await conferir(f);
  assert.equal(r.resultado, 'PRONTA_PARA_APLICAR'); assert.deepEqual(r.plano, ['migration 114']); assert.equal(r.estado.m114, 'ausente');
  assert.ok(f.log.every(x => x.ro || /^(BEGIN TRANSACTION READ ONLY|ROLLBACK)$/.test(x.sql)), 'tudo em READ ONLY');
  assert.ok(!f.log.some(x => x.sql === CORPO || x.sql === 'COMMIT'));
  assert.ok(!f.log.some(x => x.sql === comum.SQL_EXIGIR), 'sem a função, não há prova funcional');
});

test('conferência presente: prova funcional em READ ONLY, JA_APLICADA; prova falha = RECUSARIA', async () => {
  const f = clienteFalso({aplicada: true});
  const r = await conferir(f);
  assert.equal(r.resultado, 'JA_APLICADA_POSTCHECK_PASS'); assert.equal(r.provaFuncional, 'PASS');
  assert.ok(f.log.filter(x => x.sql === comum.SQL_EXIGIR).every(x => x.ro));
  assert.ok(!f.log.some(x => x.sql === 'COMMIT'));
  for (const opcoes of [{semKd114: true}, {kdOutro: '42501'}, {aceitaOutraEmpresa: true}, {aceitaOutraChave: true}]) {
    const g = await conferir(clienteFalso({aplicada: true, ...opcoes}));
    assert.equal(g.resultado, 'RECUSARIA', JSON.stringify(opcoes)); assert.match(g.motivo, /PROVA_FUNCIONAL_114/); assert.equal(g.provaFuncional, 'FALHOU');
    assert.equal((await stg.principal(['--conferir-114'], ENV_STG, {Client: clienteFalso({aplicada: true, ...opcoes}).C})).codigo, 3);
  }
});

test('conferência: divergente, sem gatilho, sem privilégio e EXECUTE restrito = RECUSARIA (código 3) pelo nome', async () => {
  for (const [opcoes, re] of [
    [{extra: {hash_revisao: 'a'.repeat(64)}}, /CORPOS_DIVERGENTES_114 f114=false lock=eb5f187f revisao=aaaaaaaa/],
    [{extra: {gatilhos: []}}, /GATILHO_DIVERGENTE_114/], [{extra: {dono_lock: false}}, /SEM_PRIVILEGIO_114 DONO_LOCK/],
    [{aplicada: true, extra: {execute_publico: false}}, /EXECUTE_RESTRITO_114/], [{semUsage: true}, /SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC/], [{extra: {tabelas: 2}}, /TABELA_AUSENTE/],
  ]) {
    const r = await conferir(clienteFalso(opcoes));
    assert.equal(r.resultado, 'RECUSARIA', JSON.stringify(opcoes)); assert.match(r.motivo, re);
    assert.equal((await stg.principal(['--conferir-114'], ENV_STG, {Client: clienteFalso(opcoes).C})).codigo, 3);
  }
});

test('identidade: banco errado na conexão vira FALHA sem aplicar', async () => {
  const f = clienteFalso({identidade: {db: 'kidmais_manager', tls: false, servidor_privado: true}});
  const r = await conferir(f);
  assert.equal(r.resultado, 'FALHA'); assert.match(r.mensagem, /IDENTIDADE_RECUSADA/);
  const g = clienteFalso({identidade: {db: 'kidmais_manager', tls: false, servidor_privado: true}});
  const e = await executar(g);
  assert.equal(e.resultado, 'FALHA'); assert.ok(!g.log.some(x => x.sql === CORPO));
});

test('aplicação: ordem exata (estado READ ONLY → corpo → estado, preservação e prova na transação → COMMIT → estado e prova READ ONLY), marcador CONCLUIDA', async () => {
  const f = clienteFalso(); const d = pasta();
  const r = await executar(f, d);
  assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r));
  assert.deepEqual(r.commits, {114: 'CONFIRMADO'}); assert.deepEqual(r.commitadas, ['114']); assert.equal(r.provaFuncionalDepois, 'PASS');
  const q = f.log.map(x => x.sql);
  const i = {corpo: q.indexOf(CORPO), commit: q.indexOf('COMMIT')};
  assert.ok(i.corpo > 0 && i.commit > i.corpo);
  const entre = q.slice(i.corpo + 1, i.commit);
  assert.ok(entre.includes(comum.SQL_ESTADO) && entre.includes(comum.SQL_PRESERVACAO) && entre.includes(comum.SQL_TRAVAR));
  assert.deepEqual(entre.filter(s => s === comum.SQL_EXIGIR).length, 5, 'sem trava, outra empresa, outra chave, com trava e empresa nula');
  assert.equal(entre.indexOf('ROLLBACK'), -1); assert.equal(q.filter(s => s === 'COMMIT').length, 1);
  const depois = f.log.slice(i.commit + 1);
  assert.ok(depois.some(x => x.sql === comum.SQL_ESTADO)); assert.ok(depois.filter(x => x.sql === comum.SQL_EXIGIR).every(x => x.ro), 'prova depois em READ ONLY');
  assert.ok(depois.some(x => x.sql === comum.SQL_EXIGIR));
  // Antes do corpo, tudo em READ ONLY.
  assert.ok(f.log.slice(0, i.corpo).every(x => x.ro || x.sql === 'ROLLBACK'));
  const m = marcador(d);
  assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.backup, BACKUP); assert.deepEqual(m.commits, {114: 'CONFIRMADO'});
  assert.deepEqual(m.etapas[0].antesDoCommit, {estado: 'PASS', preservacao: 'PASS', provaFuncional: 'PASS'});
  assert.ok(!JSON.stringify(m).includes('SENHA_FALSA'));
});

test('prova funcional: sem trava, outra empresa e outra chave recusam; só a trava da mesma empresa aleatória passa', async () => {
  const f = clienteFalso();
  await executar(f);
  const q = f.log.slice(f.log.findIndex(x => x.sql === comum.SQL_EXIGIR));
  const u = q[0].params[0];
  assert.match(u, /^[0-9a-f-]{36}$/);
  assert.deepEqual(q.slice(0, 12).map(x => x.sql), [comum.SQL_EXIGIR, 'ROLLBACK TO SAVEPOINT prova_114', comum.SQL_TRAVAR, comum.SQL_EXIGIR, 'ROLLBACK TO SAVEPOINT prova_114',
    comum.SQL_TRAVAR_OUTRA_CHAVE, comum.SQL_EXIGIR, 'ROLLBACK TO SAVEPOINT prova_114', comum.SQL_TRAVAR, comum.SQL_EXIGIR, comum.SQL_EXIGIR, 'RELEASE SAVEPOINT prova_114']);
  assert.notEqual(q[2].params[0], u, 'trava de outra empresa'); assert.equal(q[3].params[0], u);
  assert.equal(q[5].params[0], u); assert.equal(q[6].params[0], u);
  assert.equal(q[8].params[0], u); assert.equal(q[9].params[0], u); assert.equal(q[10].params[0], null);
  // Cada prova usa empresas novas: a de depois do COMMIT não repete a de antes.
  assert.equal(new Set(f.log.filter(x => x.sql === comum.SQL_TRAVAR).map(x => x.params[0])).size, 4);
  for (const [opcoes, re] of [[{aceitaOutraEmpresa: true}, /PROVA_FUNCIONAL_114 trava de outra empresa: SEM_ERRO/], [{aceitaOutraChave: true}, /PROVA_FUNCIONAL_114 trava de outra chave: SEM_ERRO/]]) {
    const g = clienteFalso(opcoes); const r = await executar(g);
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, re); assert.deepEqual(r.commits, {114: 'NAO_COMMITADA'}); assert.equal(g.commits(), 0);
  }
});

test('commit do Render na saída: só SHA, ausente ou inválido = null', async () => {
  const SHA = '753e065d1549b3dde4830c369e7e5a99b00f241b';
  assert.equal((await stg.conferir({env: {...ENV_STG, RENDER_GIT_COMMIT: SHA}, Client: clienteFalso().C})).commitImplantado, SHA);
  assert.equal((await stg.conferir({env: ENV_STG, Client: clienteFalso().C})).commitImplantado, null);
  assert.equal((await stg.conferir({env: {...ENV_STG, RENDER_GIT_COMMIT: 'x; rm'}, Client: clienteFalso().C})).commitImplantado, null);
  assert.equal((await stg.executar({env: {...ENV_STG, RENDER_GIT_COMMIT: SHA}, backup: BACKUP, dir: pasta(), raiz, disco: () => {}, Client: clienteFalso().C})).commitImplantado, SHA);
});

test('já aplicada: nenhum corpo enviado, JA_APLICADA, sem COMMIT', async () => {
  const f = clienteFalso({aplicada: true});
  const r = await executar(f);
  assert.equal(r.resultado, 'JA_APLICADA_POSTCHECK_PASS');
  assert.ok(!f.log.some(x => x.sql === CORPO || x.sql === 'COMMIT'));
});

test('recusas antes da escrita: divergente e sem privilégio ficam NAO aplicadas, sem corpo', async () => {
  for (const [opcoes, re] of [[{extra: {hash_lock: 'b'.repeat(64)}}, /CORPOS_DIVERGENTES_114/], [{extra: {pode_criar: false}}, /SEM_PRIVILEGIO_114 CREATE/], [{extra: {gatilhos: TODOS.slice(1)}}, /GATILHO_DIVERGENTE_114/]]) {
    const f = clienteFalso(opcoes); const d = pasta();
    const r = await executar(f, d);
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, re); assert.deepEqual(r.commitadas, []);
    assert.ok(!f.log.some(x => x.sql === CORPO || x.sql === 'COMMIT'), JSON.stringify(opcoes));
    assert.equal(marcador(d).situacao, 'FALHA');
  }
});

test('falha antes do COMMIT: NAO_COMMITADA e COMMIT nunca enviado, em cada verificação', async () => {
  for (const [nome, opcoes, re] of [
    ['corpo', {falharEm: 'CREATE FUNCTION public.kidmais114', erro: erroPg('55P03', 'lock_timeout')}, /lock_timeout/],
    ['estado na transação', {naTransacao: {hash_lock: comum.CORPOS.antes.lock}}, /ESTADO_NA_TRANSACAO_114 divergente/],
    ['gatilho na transação', {naTransacao: {gatilhos: []}}, /GATILHO_DIVERGENTE_114/],
    ['EXECUTE restrito na transação', {naTransacao: {execute_publico: false}}, /EXECUTE_RESTRITO_114/],
    ...comum.PRESERVADAS.map(t => [`escrita em ${t}`, {preservacao: linhaCom(t, {escritas: 1})}, new RegExp(`PRESERVACAO_114 ${t}=1`)]),
    ...comum.PRESERVADAS.map(t => [`arquivo trocado em ${t}`, {preservacao: linhaCom(t, {arquivo: '9'})}, new RegExp(`PRESERVACAO_114 ${t}=ARQUIVO_TROCADO`)]),
    ...comum.PRESERVADAS.map(t => [`sem linha de ${t}`, {preservacao: ZERO.filter(l => l.tabela !== t)}, new RegExp(`PRESERVACAO_114 ${t}=AUSENTE`)]),
    ['contador ilegível', {preservacao: linhaCom('contratos', {escritas: null})}, /PRESERVACAO_114 contratos=null/],
    ['sem KD114', {semKd114: true}, /PROVA_FUNCIONAL_114 sem a trava: SEM_ERRO/],
    ['outro erro sem a trava', {kdOutro: '42501'}, /PROVA_FUNCIONAL_114 sem a trava: 42501/],
  ]) {
    const f = clienteFalso(opcoes); const d = pasta();
    const r = await executar(f, d);
    assert.equal(r.resultado, 'FALHA', nome); assert.match(r.falha.mensagem, re, nome);
    assert.deepEqual(r.commits, {114: 'NAO_COMMITADA'}, nome); assert.deepEqual(r.commitadas, [], nome);
    assert.equal(f.commits(), 0, nome); assert.equal(f.atual.aplicada, false, nome);
    assert.ok(f.log.at(-1).sql === 'ROLLBACK', nome);
    assert.equal(marcador(d).situacao, 'FALHA', nome); assert.match(r.reconciliar, /--conferir-114/);
  }
});

test('falha NO COMMIT: situação correta por SQLSTATE; transporte e 40003 = INDETERMINADO; resposta ROLLBACK = DESFEITA', async () => {
  for (const [falharCommit, esperado] of [
    [{erro: erroPg('23514')}, 'DESFEITA_PELO_SERVIDOR'], [{erro: erroPg('40001')}, 'DESFEITA_PELO_SERVIDOR'],
    [{erro: erroPg('40003')}, 'INDETERMINADO'], [{erro: erroPg('08006')}, 'INDETERMINADO'], [{erro: erroPg('57P01')}, 'INDETERMINADO'], [{erro: erroPg('58000')}, 'INDETERMINADO'], [{erro: erroPg('XX000')}, 'INDETERMINADO'],
    [{erro: erroNode('EPIPE')}, 'INDETERMINADO'], [{erro: erroNode('ECONNRESET', 'read')}, 'INDETERMINADO'], [{erro: new Error('sem código')}, 'INDETERMINADO'],
    [{rollback: true}, 'DESFEITA_PELO_SERVIDOR'],
  ]) {
    const f = clienteFalso({falharCommit}); const d = pasta();
    const r = await executar(f, d);
    assert.equal(r.resultado, 'FALHA'); assert.deepEqual(r.commits, {114: esperado}, JSON.stringify(falharCommit.erro?.code ?? 'rollback'));
    assert.equal(marcador(d).commits['114'], esperado);
  }
});

test('depois do COMMIT: estado divergente ou prova falha = FALHA com CONFIRMADO (nunca esconde o COMMIT)', async () => {
  for (const [opcoes, re] of [[{depoisDoCommit: {hash_lock: comum.CORPOS.antes.lock}}, /ESTADO_DEPOIS_114/], [{depoisDoCommit: {execute_publico: false}}, /EXECUTE_RESTRITO_114/]]) {
    const r = await executar(clienteFalso(opcoes));
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, re); assert.deepEqual(r.commits, {114: 'CONFIRMADO'}); assert.deepEqual(r.commitadas, ['114']);
  }
});

test('preservação: leitura de antes precisa dar zero; acumulado da sessão não é compensado por diferença', async () => {
  const com = n => ZERO.map(l => (l.tabela === 'contratos' ? {...l, escritas: n} : l));
  comum.exigirPreservacao(ZERO, ZERO);
  assert.throws(() => comum.exigirPreservacao(com(5), com(5)), /PRESERVACAO_114 contratos=ACUMULADO_ANTERIOR contratos=5/, 'mesma diferença zero');
  assert.throws(() => comum.exigirPreservacao(ZERO, com(5)), /PRESERVACAO_114 contratos=ACUMULADO_ANTERIOR/, 'acumulado enviado entre as leituras');
  assert.throws(() => comum.exigirPreservacao(com(1), ZERO), /PRESERVACAO_114 contratos=1/);
  assert.throws(() => comum.exigirPreservacao(com(null), ZERO), /PRESERVACAO_114 contratos=null/);
  assert.throws(() => comum.exigirPreservacao(ZERO, []), /PRESERVACAO_114 fechamentos=ACUMULADO_ANTERIOR fechamentos=ARQUIVO_TROCADO/);
  // No fluxo: sessão com acumulado recusa antes do corpo, sem marcar commit.
  const f = clienteFalso({acumulado: com(5)}); const r = await executar(f);
  assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /ACUMULADO_ANTERIOR/); assert.deepEqual(r.commits, {114: 'NAO_COMMITADA'});
  assert.ok(!f.log.some(x => x.sql === CORPO || x.sql === 'COMMIT'));
});

test('marcador: segunda tentativa recusa antes de conectar; renomeado, a retomada registra a anterior; arquivo alterado recusa antes do marcador', async () => {
  const d = pasta();
  assert.equal((await executar(clienteFalso({falharEm: comum.SQL_PRESERVACAO}), d)).resultado, 'FALHA');
  const f = clienteFalso();
  await assert.rejects(() => executar(f, d), /TENTATIVA_ANTERIOR_REVISAR/);
  assert.equal(f.log.length, 0, 'sem conexão');
  fs.renameSync(path.join(d, comum.MARCADOR), path.join(d, 'migration-114.20261105T2200.json'));
  const r = await executar(clienteFalso(), d);
  assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS');
  assert.deepEqual(marcador(d).tentativasAnteriores, ['migration-114.20261105T2200.json']);
  const outra = fs.mkdtempSync(path.join(os.tmpdir(), 'raiz-114-'));
  fs.mkdirSync(path.join(outra, path.dirname(ARQ)), {recursive: true}); fs.writeFileSync(path.join(outra, ARQ), M114 + '-- x\n');
  const e = pasta();
  await assert.rejects(() => stg.executar({env: ENV_STG, backup: BACKUP, dir: e, raiz: outra, disco: () => {}, Client: clienteFalso().C}), /ARQUIVO_DIVERGENTE/);
  assert.deepEqual(fs.readdirSync(e), []);
});

test('disco exigido antes do marcador e códigos de saída 0/2/3', async () => {
  const d = pasta();
  await assert.rejects(() => stg.executar({env: ENV_STG, backup: BACKUP, dir: d, raiz, disco: () => assert.fail('DISCO_AUSENTE'), Client: clienteFalso().C}), /DISCO_AUSENTE/);
  assert.deepEqual(fs.readdirSync(d), []);
  assert.equal((await stg.principal(['--conferir-114'], ENV_STG, {Client: clienteFalso().C})).codigo, 0);
  assert.equal((await stg.principal(['--aplicar-114-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso().C, dir: pasta(), raiz, disco: () => {}})).codigo, 0);
  assert.equal((await stg.principal(['--aplicar-114-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso({falharEm: comum.SQL_PRESERVACAO}).C, dir: pasta(), raiz, disco: () => {}})).codigo, 2);
  assert.equal((await stg.principal(['--conferir-114'], ENV_STG, {Client: clienteFalso({extra: {gatilhos: []}}).C})).codigo, 3);
});
