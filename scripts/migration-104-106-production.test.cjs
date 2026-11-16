/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 104/106 de PRODUÇÃO com cliente simulado (o mesmo desenho da suíte de staging: só CONFIRMA no COMMIT e
// descarta no ROLLBACK): trava de alvo e identidade de produção (TLS obrigatório, identidade provada no servidor), disco
// persistente, cruzamento com staging, variável faltando recusa ANTES de conectar, estados ausente/completa/parcial/
// divergente, atividade nas tabelas, sha dos 8 SQL, aplicação com marcador próprio de produção, COMMIT indeterminado e a
// ordem de produção no plano. O núcleo (scripts/migration-104-106-comum.cjs) é o de staging, intacto. Sem rede nem banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const comum = require('./migration-104-106-comum.cjs');
const {lerRevisado} = require('./migration-092-094-comum.cjs');
const prod = require('./migration-104-106-production.cjs');
const stg = require('./migration-104-106-staging.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_PROD = 'postgresql://usuario:SENHA_FALSA@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production';
const ENV_PROD = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'false', DATABASE_URL: URL_PROD});
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false',
  DATABASE_URL: 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'});
const ID_PROD = {db: 'kidmais_production', tls: true, tls_versao: 'TLSv1.3', servidor_privado: true};
const CONEXAO = {banco: 'kidmais_production', tls: true, tlsVersao: 'TLSv1.3', servidorPrivado: true};
const BACKUP = 'PITR 2026-11-12T03:00Z production ref-1';
const CONFERIR = ['--conferir-104-106'], APLICAR = ['--aplicar-104-106-autorizado', '--backup', BACKUP];
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
const PLANO_TUDO = ['precheck 104', 'migration 104', 'integridade 104', 'postcheck 104', 'precheck 106', 'migration 106', 'postcheck 106', 'integridade 106'];

/** Cliente simulado transacional (como na suíte de staging); a identidade é a linha de prod.SQL_IDENTIDADE. */
function clienteFalso({inicial = estado(), identidade = ID_PROD, falharEm, soNaTransacao = false, erro, falharCommit, atividade = SEM_ATIVIDADE, executa = true} = {}) {
  const log = []; let ro = false, pendente = null, commits = 0;
  const atual = {...inicial};
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') ro = true;
      log.push({sql, ro, emTransacao: pendente !== null});
      if (falharEm && sql.includes(falharEm) && (!soNaTransacao || pendente)) throw erro ?? erroPg('P0001', 'falha simulada em ' + falharEm);
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
      if (sql === prod.SQL_IDENTIDADE) return {rows: [identidade]};
      if (sql === comum.SQL_ESTADO) return {rows: [{...atual}]};
      if (sql === comum.SQL_ATIVIDADE) return {rows: [{...atividade}]};
      if (sql.includes('AS saloes')) return {rows: [{...CONTAGENS}]};
      if (sql === X104) return {rows: [{executa_104: executa}]};
      if (sql === X106) return {rows: [{executa_106: executa}]};
      if (sql === C104) { assert.equal(ro, false, 'migration nunca em READ ONLY'); pendente = {aplicar: () => Object.assign(atual, COMPLETA_104)}; }
      if (sql === C106) { assert.equal(ro, false, 'migration nunca em READ ONLY'); pendente = {aplicar: () => Object.assign(atual, COMPLETA_106)}; }
      assert.ok(sql !== M104 && sql !== M106, 'o arquivo COM o COMMIT final nunca é enviado');
      return {rows: []};
    }
  };
  C.log = log; C.atual = atual;
  return C;
}
/** Cliente que não pode nem ser construído: prova de que a recusa veio ANTES de conectar. */
function nuncaConecta() {
  const N = class { constructor() { N.construido = true; throw new Error('CONECTOU'); } };
  N.construido = false;
  return N;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-104-106-prod-'));
const semDisco = () => {};
const escritas = log => log.filter(x => !x.ro && !/^(BEGIN TRANSACTION READ ONLY|ROLLBACK|COMMIT|SET LOCAL)/.test(x.sql) && !x.emTransacao);
const leuDados = C => C.log.some(x => x.sql === comum.SQL_ATIVIDADE || x.sql.includes('AS saloes') || comum.ETAPAS.some(([n]) => x.sql === ler(n)));
const ALVOS_ERRADOS = [[{RENDER: undefined}, /^FORA_DO_RENDER$/], [{RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}, /^SERVICO_RECUSADO$/], [{RENDER_SERVICE_ID: undefined}, /^SERVICO_RECUSADO$/],
  [{KIDMAIS_DEPLOY_ENV: 'staging'}, /^AMBIENTE_RECUSADO$/], [{KIDMAIS_DEPLOY_ENV: undefined}, /^AMBIENTE_RECUSADO$/],
  [{DATABASE_SSL: 'false'}, /^TLS_OBRIGATORIO$/], [{DATABASE_SSL: undefined}, /^TLS_OBRIGATORIO$/],
  [{DATABASE_URL: undefined}, /^URL_RECUSADA$/], [{DATABASE_URL: 'nao-e-url'}, /^URL_RECUSADA$/],
  [{DATABASE_URL: URL_PROD.replace('kidmais_production', 'kidmais_staging_1z91')}, /^BANCO_RECUSADO$/],
  [{DATABASE_URL: URL_PROD.replace('kidmais_production', 'kidmais_manager')}, /^BANCO_RECUSADO$/],
  [{DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'dpg-daidko3m8hqs73ce4jt0-a')}, /^HOST_RECUSADO$/],
  [{DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'dpg-dak750gae00c73fudmg0-a.virginia-postgres.render.com')}, /^HOST_RECUSADO$/],
  [{DATABASE_URL: URL_PROD.replace(':5432/', ':6543/')}, /^PORTA_RECUSADA$/], [{DATABASE_URL: URL_PROD + '?sslmode=disable'}, /^CONNECTION_QUERY_REJECTED$/]];

test('sha dos 8 SQL fixados no núcleo conferem com a árvore; o plano de produção lista os mesmos arquivos e os corpos da função de hash', async () => {
  for (const [, arquivo, hash] of comum.ETAPAS) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), hash, arquivo);
  }
  assert.deepEqual(comum.ETAPAS.map(e => e[0]), PLANO_TUDO);
  const {saida} = await prod.principal([], {});
  assert.deepEqual(saida.arquivos.map(a => [a.arquivo, a.sha256]), comum.ETAPAS.map(e => [e[1], e[2]]));
  assert.deepEqual(saida.funcaoHash, {corpo016: comum.CORPO_HASH_016, corpo104: comum.CORPO_HASH_104});
  assert.ok(!saida.arquivos.some(a => a.arquivo.includes('rollback')));
});

test('trava de alvo de produção: serviço, ambiente, TLS obrigatório (certificado conforme o serviço), host, banco, porta, URL sem query', () => {
  const o = prod.alvo(ENV_PROD);
  assert.deepEqual(o.ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'});
  assert.equal(o.application_name, 'kidmais-migration-104-106-production'); assert.equal(o.connectionString, URL_PROD);
  assert.equal(prod.alvo({...ENV_PROD, DATABASE_SSL_REJECT_UNAUTHORIZED: undefined}).ssl.rejectUnauthorized, true);
  for (const [delta, erro] of ALVOS_ERRADOS) assert.throws(() => prod.alvo({...ENV_PROD, ...delta}), e => erro.test(e.message), JSON.stringify(delta));
  for (const delta of [{DATABASE_URL: URL_PROD + '?password=SEGREDO'}, {DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'host-SEGREDO')}]) {
    let msg = ''; try { prod.alvo({...ENV_PROD, ...delta}); } catch (e) { msg = String(e.message); }
    assert.match(msg, /^[A-Z_]+$/); assert.ok(!msg.includes('SEGREDO') && !msg.includes('SENHA_FALSA'));
  }
  assert.throws(() => stg.alvo(ENV_PROD), /SERVICO_RECUSADO/);
  assert.throws(() => prod.alvo(ENV_STG), /SERVICO_RECUSADO/);
  assert.deepEqual(prod.ALVO, {servico: 'srv-dak77m2d0e5s73b8rkkg', host: 'dpg-dak750gae00c73fudmg0-a', database: 'kidmais_production', port: 5432});
  assert.equal(prod.DIR, '/opt/render/project/src/data/saloes-104-106-producao'); assert.notEqual(prod.DIR, stg.DIR);
});

test('alvo errado ou variável faltando: CONFERIR e APLICAR recusam (lançam, código 1 na CLI) ANTES de construir o cliente e de tocar o disco', async () => {
  for (const [delta, erro] of ALVOS_ERRADOS) {
    const env = {...ENV_PROD, ...delta};
    for (const argv of [CONFERIR, APLICAR]) {
      const N = nuncaConecta(); const dir = path.join(os.tmpdir(), 'nao-criado-104-106-prod');
      await assert.rejects(prod.principal(argv, env, {Client: N, dir, disco: () => assert.fail('DISCO_CONSULTADO')}), e => erro.test(e.message), JSON.stringify(delta) + argv[0]);
      assert.equal(N.construido, false, 'cliente não construído'); assert.equal(fs.existsSync(dir), false, 'nada no disco');
    }
  }
  await assert.rejects(prod.principal(CONFERIR, ENV_STG, {Client: nuncaConecta()}), /SERVICO_RECUSADO/);
  await assert.rejects(prod.principal(['--aplicar-104-106-autorizado'], ENV_PROD, {Client: nuncaConecta()}), /BACKUP_OBRIGATORIO/);
  await assert.rejects(prod.principal(['--aplicar-104-106-autorizado', '--backup', 'x;rm'], ENV_PROD, {Client: nuncaConecta()}), /BACKUP_INVALIDO/);
  await assert.rejects(prod.principal(['--conferir-102-103'], ENV_PROD, {Client: nuncaConecta()}), /ARGUMENTOS_RECUSADOS/);
});

test('identidade provada pelo servidor: banco de produção, TLS ativo 1.2/1.3 e servidor em rede privada; disco persistente', async () => {
  assert.deepEqual(prod.identidade(ID_PROD), CONEXAO);
  assert.equal(prod.identidade({...ID_PROD, tls_versao: 'TLSv1.2'}).tlsVersao, 'TLSv1.2');
  for (const [delta, erro] of [[{db: 'kidmais_staging_1z91'}, /BANCO_DIVERGENTE/], [{tls: false}, /SEM_TLS/], [{tls: null}, /SEM_TLS/],
    [{tls_versao: 'TLSv1.1'}, /TLS_VERSAO_RECUSADA/], [{servidor_privado: false}, /SERVIDOR_FORA_DA_REDE_PRIVADA/]])
    assert.throws(() => prod.identidade({...ID_PROD, ...delta}), erro);
  assert.throws(() => prod.identidade(undefined), /BANCO_DIVERGENTE/);
  assert.match(prod.SQL_IDENTIDADE, /pg_stat_ssl/); assert.match(prod.SQL_IDENTIDADE, /inet_server_addr\(\)/);
  assert.throws(() => prod.exigirDisco(path.join(os.tmpdir(), 'nao-existe-104-106-prod')), /DISCO_PERSISTENTE_AUSENTE/);
  const st = (dev, extra = {}) => ({dev, isDirectory: () => true, isSymbolicLink: () => false, ...extra});
  assert.doesNotThrow(() => prod.exigirDisco('/d/data', p => (p === '/d/data' ? st(2) : st(1))));
  assert.throws(() => prod.exigirDisco('/d/data', () => st(1)), /DISCO_PERSISTENTE_AUSENTE/, 'mesmo dispositivo do pai = disco efêmero');
  assert.throws(() => prod.exigirDisco('/d/data', p => (p === '/d/data' ? st(2, {isSymbolicLink: () => true}) : st(1))), /DISCO_PERSISTENTE_AUSENTE/);
  for (const id of [{...ID_PROD, db: 'kidmais_staging_1z91'}, {...ID_PROD, tls: false}, {...ID_PROD, servidor_privado: false}]) {
    const C = clienteFalso({identidade: id});
    const x = await prod.principal(CONFERIR, ENV_PROD, {Client: C});
    assert.equal(x.codigo, 2); assert.equal(x.saida.resultado, 'FALHA'); assert.ok(!JSON.stringify(x).includes('SENHA_FALSA'));
    assert.ok(!C.log.some(l => l.sql === comum.SQL_ESTADO), 'estado não lido');
    const dir = tmp();
    try {
      const A = clienteFalso({identidade: id});
      const a = await prod.principal(APLICAR, ENV_PROD, {Client: A, dir, disco: semDisco});
      assert.equal(a.codigo, 2); assert.deepEqual(a.saida.commits, {}); assert.deepEqual(escritas(A.log), []);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('conferência de produção: só leitura, nada no disco; ausente = prechecks + atividade (PRONTA); completa = integridade e auditoria (JA_APLICADA)', async () => {
  const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
  fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
  try {
    const Pronta = clienteFalso();
    const x = await prod.principal(CONFERIR, ENV_PROD, {Client: Pronta});
    assert.equal(x.codigo, 0); assert.equal(x.saida.resultado, 'PRONTA_PARA_APLICAR', JSON.stringify(x.saida));
    assert.deepEqual(x.saida.conexao, CONEXAO); assert.deepEqual(x.saida.plano, PLANO_TUDO);
    assert.deepEqual(x.saida.checks, {'precheck 104': 'PASS', 'precheck 106': 'PASS'}); assert.deepEqual(x.saida.atividade, SEM_ATIVIDADE);
    assert.deepEqual(escritas(Pronta.log), []); assert.ok(!Pronta.log.some(l => l.sql === C104 || l.sql === C106));
    const i = s => Pronta.log.findIndex(l => l.sql === s);
    assert.ok(i(prod.SQL_IDENTIDADE) < i(comum.SQL_ESTADO) && i(comum.SQL_ESTADO) < i(comum.SQL_ATIVIDADE) && i(comum.SQL_ATIVIDADE) < i(ler('precheck 104')), 'identidade → catálogo → atividade → dados');
    const Aplicada = clienteFalso({inicial: estado({...COMPLETA_104, ...COMPLETA_106})});
    const j = await prod.principal(CONFERIR, ENV_PROD, {Client: Aplicada});
    assert.equal(j.codigo, 0); assert.equal(j.saida.resultado, 'JA_APLICADA_INTEGRIDADE_PASS', JSON.stringify(j.saida));
    assert.deepEqual(j.saida.checks, {'integridade 104': 'PASS', 'postcheck 104': 'PASS', 'integridade 106': 'PASS'});
    assert.equal(j.saida.atividade, null, 'sem pendente, a atividade não é lida'); assert.deepEqual(escritas(Aplicada.log), []);
  } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
  assert.deepEqual(gravacoes, [], 'a conferência não grava arquivos');
});

test('produção recusa (CONFERIR código 3, APLICAR código 2, nada escrito): parcial, divergente, dependência, privilégio e atividade', async () => {
  for (const [opcoes, motivo, semDados] of [[{inicial: estado({m104_marcadores: 2})}, /APLICACAO_PARCIAL_104/, true], [{inicial: estado({m106_marcadores: 3})}, /APLICACAO_PARCIAL_106/, true],
    [{inicial: estado({m104_marcadores: 4})}, /APLICACAO_PARCIAL_104/, true], [{inicial: estado({hash_corpo: 'b'.repeat(64)})}, /FUNCAO_HASH_DIVERGENTE_104/, true],
    [{inicial: estado({hash_meta: false})}, /FUNCAO_HASH_DIVERGENTE_104/, true], [{inicial: estado({d104: false})}, /SEM_DEPENDENCIA_104/, true],
    [{inicial: estado({d106: false})}, /SEM_DEPENDENCIA_106/, true], [{inicial: estado({dono_revisoes: false})}, /SEM_PRIVILEGIO_104 DONO_FECHAMENTO_REVISOES/, true],
    [{inicial: estado({ver_atividade: false})}, /ATIVIDADE_NAO_VERIFICAVEL/, true],
    [{atividade: {...SEM_ATIVIDADE, locks: 1, sessoes: 1, sessoes_em_transacao: 1}}, /ATIVIDADE_NAS_TABELAS 1 sessão/, false],
    [{atividade: {...SEM_ATIVIDADE, locks: 1, locks_sem_pid: 1, sem_contexto: 1}}, /ATIVIDADE_NAO_VERIFICAVEL 1 sem contexto/, false]]) {
    const C = clienteFalso(opcoes);
    const x = await prod.principal(CONFERIR, ENV_PROD, {Client: C});
    assert.equal(x.codigo, 3, String(motivo) + JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'RECUSARIA'); assert.match(x.saida.motivo, motivo);
    assert.deepEqual(escritas(C.log), []);
    if (semDados) assert.ok(!leuDados(C), String(motivo) + ': recusa do catálogo antes de qualquer dado');
    const dir = tmp();
    try {
      const A = clienteFalso(opcoes);
      const a = await prod.principal(APLICAR, ENV_PROD, {Client: A, dir, disco: semDisco});
      assert.equal(a.codigo, 2, String(motivo)); assert.match(a.saida.falha.mensagem, motivo); assert.deepEqual(a.saida.commits, {});
      assert.deepEqual(escritas(A.log), [], 'aplicação recusa antes de qualquer migration');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('aplicação em produção: disco exigido antes de conectar, corpos sem COMMIT, verificações (com EXECUTE) na transação, marcador de produção exclusivo', async () => {
  const N = nuncaConecta();
  await assert.rejects(prod.executar({env: ENV_PROD, backup: BACKUP, dir: tmp(), Client: N}), /DISCO_PERSISTENTE_AUSENTE/);
  assert.equal(N.construido, false, 'disco padrão do adaptador (ausente fora do Render) recusa antes de conectar');
  const dir = tmp();
  try {
    const C = clienteFalso();
    const x = await prod.principal(APLICAR, ENV_PROD, {Client: C, dir, disco: semDisco});
    assert.equal(x.codigo, 0); assert.equal(x.saida.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(x.saida));
    assert.deepEqual(x.saida.etapas, PLANO_TUDO); assert.deepEqual(x.saida.commits, {104: 'CONFIRMADO', 106: 'CONFIRMADO'});
    assert.deepEqual(escritas(C.log).map(l => l.sql), [C104, C106], 'só os corpos (sem COMMIT) escrevem, na ordem');
    for (const [corpo, verifs] of [[C104, [ler('integridade 104'), X104]], [C106, [ler('postcheck 106'), ler('integridade 106'), X106]]]) {
      const i = C.log.findIndex(l => l.sql === corpo), iCommit = C.log.findIndex((l, k) => k > i && l.sql === 'COMMIT');
      for (const sql of verifs) {
        const k = C.log.findIndex((l, n) => n > i && l.sql === sql);
        assert.ok(k > i && k < iCommit && C.log[k].emTransacao && !C.log[k].ro, 'verificação dentro da transação, antes do COMMIT');
      }
    }
    assert.ok(C.log.findIndex(l => l.sql === comum.SQL_ATIVIDADE) < C.log.findIndex(l => l.sql === C104), 'atividade lida antes da primeira escrita');
    const m = JSON.parse(fs.readFileSync(x.saida.marcador, 'utf8'));
    assert.equal(path.basename(x.saida.marcador), 'migration-104-106.json');
    assert.equal(m.ambiente, 'production'); assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.backup, BACKUP); assert.deepEqual(m.conexao, CONEXAO);
    assert.ok(!fs.readFileSync(x.saida.marcador, 'utf8').includes('SENHA_FALSA'));
    await assert.rejects(prod.principal(APLICAR, ENV_PROD, {Client: clienteFalso(), dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  const dir2 = tmp();
  try {
    const J = clienteFalso({inicial: estado({...COMPLETA_104, ...COMPLETA_106})});
    const r = await prod.executar({env: ENV_PROD, backup: BACKUP, dir: dir2, Client: J, disco: semDisco});
    assert.equal(r.resultado, 'JA_APLICADA_INTEGRIDADE_PASS'); assert.deepEqual(escritas(J.log), []); assert.deepEqual(r.commits, {});
  } finally { fs.rmSync(dir2, {recursive: true, force: true}); }
});

test('falhas na aplicação em produção: verificação antes do COMMIT = NAO_COMMITADA; COMMIT 40003/sem resposta = INDETERMINADO; recusa e ROLLBACK respondido = desfeita; código 2', async () => {
  for (const [rotulo, opcoes, commits] of [
    ['EXECUTE das funções novas falso', {executa: false}, {104: 'NAO_COMMITADA'}],
    ['integridade 104 na transação', {falharEm: '104 integridade:', soNaTransacao: true}, {104: 'NAO_COMMITADA'}],
    ['COMMIT 104 40003', {falharCommit: {n: 1, erro: erroPg('40003')}}, {104: 'INDETERMINADO'}],
    ['COMMIT 104 sem resposta', {falharCommit: {n: 1, erro: new Error('Connection terminated unexpectedly')}}, {104: 'INDETERMINADO'}],
    ['COMMIT 104 recusado', {falharCommit: {n: 1, erro: erroPg('23514')}}, {104: 'DESFEITA_PELO_SERVIDOR'}],
    ['COMMIT 104 respondido como ROLLBACK', {falharCommit: {n: 1, rollback: true}}, {104: 'DESFEITA_PELO_SERVIDOR'}],
    ['COMMIT 106 40003', {falharCommit: {n: 2, erro: erroPg('40003')}}, {104: 'CONFIRMADO', 106: 'INDETERMINADO'}]]) {
    const dir = tmp();
    try {
      const C = clienteFalso(opcoes);
      const x = await prod.principal(APLICAR, ENV_PROD, {Client: C, dir, disco: semDisco});
      assert.equal(x.codigo, 2, rotulo + JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'FALHA', rotulo); assert.deepEqual(x.saida.commits, commits, rotulo);
      assert.match(x.saida.reconciliar, /--conferir-104-106/);
      const m = JSON.parse(fs.readFileSync(x.saida.marcador, 'utf8'));
      assert.equal(m.situacao, 'FALHA'); assert.equal(m.ambiente, 'production'); assert.deepEqual(m.commits, commits, rotulo + ' (marcador)');
      if (!('106' in commits)) assert.ok(!C.log.some(l => l.sql === C106), rotulo + ': 106 não roda');
      await assert.rejects(prod.principal(APLICAR, ENV_PROD, {Client: clienteFalso(), dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('plano de produção sem conexão: alvo e registro de produção, ordem de produção (PITR de production, janela drenada, autorização própria); staging mantém a dele', async () => {
  const N = nuncaConecta();
  const {codigo, saida} = await prod.principal([], {}, {Client: N});
  assert.equal(codigo, 0); assert.equal(N.construido, false); assert.equal(saida.conecta, false); assert.equal(saida.ambiente, 'production');
  assert.deepEqual(saida.alvo, prod.ALVO); assert.equal(saida.registro, prod.DIR);
  assert.deepEqual(saida.ordem, [...prod.ORDEM]); assert.deepEqual(prod.plano().ordem, [...prod.ORDEM]);
  assert.ok(saida.ordem.indexOf('--conferir-104-106: PRONTA_PARA_APLICAR') < saida.ordem.indexOf('--aplicar-104-106-autorizado'));
  assert.ok(saida.ordem.some(o => /PITR do PostgreSQL de production/.test(o) && /export lógico NÃO substitui/.test(o)));
  assert.ok(saida.ordem.includes('autorização de Felipe para a 104/106 em production'));
  assert.ok(saida.ordem.some(o => /imediatamente antes/.test(o)) && saida.ordem.some(o => /janela drenada/.test(o) && /ACCESS EXCLUSIVE em fechamentos/.test(o)));
  assert.ok(!saida.ordem.some(o => /staging|#254/.test(o)), 'nada da ordem de staging');
  const s = (await stg.principal([], {})).saida;
  for (const k of ['arquivos', 'funcaoHash', 'modos', 'preRequisitos', 'paradas', 'recuperacao', 'nuncaExecuta']) assert.deepEqual(saida[k], s[k], k);
  assert.ok(s.ordem.some(o => /PostgreSQL de staging/.test(o)), 'staging mantém a ordem dele');
  for (const n of ['down 104', 'down 106', 'ligar SALOES_PUBLICOS']) assert.ok(saida.nuncaExecuta.includes(n), n);
  assert.deepEqual(prod.CODIGO, stg.CODIGO);
});
