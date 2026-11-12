/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 102/103 de PRODUÇÃO com cliente simulado (o mesmo desenho da suíte de staging: só CONFIRMA no COMMIT e
// descarta no ROLLBACK): trava de alvo e identidade de produção (TLS obrigatório, identidade provada no servidor), disco
// persistente, cruzamento com staging, variável faltando recusa ANTES de conectar, estados ausente/completa/parcial, 098
// e versão do PostgreSQL, sha dos 7 SQL, aplicação com marcador próprio de produção, COMMIT indeterminado e a ordem de
// produção no plano. O núcleo (scripts/migration-102-103-comum.cjs) é o de staging, intacto. Sem rede nem banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const comum = require('./migration-102-103-comum.cjs');
const {lerRevisado} = require('./migration-092-094-comum.cjs');
const prod = require('./migration-102-103-production.cjs');
const stg = require('./migration-102-103-staging.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_PROD = 'postgresql://usuario:SENHA_FALSA@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production';
const ENV_PROD = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'false', DATABASE_URL: URL_PROD});
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false',
  DATABASE_URL: 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'});
const ID_PROD = {db: 'kidmais_production', tls: true, tls_versao: 'TLSv1.3', servidor_privado: true};
const CONEXAO = {banco: 'kidmais_production', tls: true, tlsVersao: 'TLSv1.3', servidorPrivado: true};
const BACKUP = 'PITR 2026-11-12T03:00Z production ref-1';
const ler = nome => { const [, a, h] = comum.ETAPAS.find(e => e[0] === nome); return lerRevisado(raiz, a, h); };
const M102 = ler('migration 102'), M103 = ler('migration 103'), I102 = ler('integridade 102');
const C102 = comum.semCommitFinal(M102, 'm102'), C103 = comum.semCommitFinal(M103, 'm103');
const erroPg = (code, msg = 'erro simulado') => Object.assign(new Error(msg), {code});
const COMPLETA_102 = {m102_colunas: 13, m102_tabelas: 3, m102_funcoes: 9};
const estado = (extra = {}) => ({versao_pg: 180006, d102: true, d103: true, m102_colunas: 0, m102_tabelas: 0, m102_funcoes: 0, com_098: false,
  usar_public: true, pode_criar: true, ler_saloes: true, ler_102: true, dono_102: true, gatilho_102: true, referencias_102: true, linguagens_102: true, plpgsql: true,
  ler_103: true, inserir_103: true, travar_103: true, papel_trocado: true, ...extra});
const CONTAGENS = {saloes: 3, saloes_ativos: 2, categorias_adicionais: 9};
const PLANO_TUDO = ['precheck 102', 'migration 102', 'postcheck 102', 'integridade 102', 'precheck 103', 'migration 103', 'postcheck 103'];

/** Cliente simulado transacional (como na suíte de staging); a identidade é a linha de prod.SQL_IDENTIDADE. */
function clienteFalso({inicial = estado(), linha = 'AUSENTE', identidade = ID_PROD, falharEm, erro, falharCommit, integra = true, integraNaTransacao = true} = {}) {
  const log = []; let ro = false, pendente = null, commits = 0;
  const atual = {...inicial}; const cat = {linha};
  const C = class {
    on() {} async connect() { C.conexoes++; } async end() {}
    async query(sql) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') ro = true;
      log.push({sql, ro, emTransacao: pendente !== null});
      if (falharEm && sql.includes(falharEm)) throw erro ?? erroPg('55P03', 'falha simulada em ' + falharEm);
      if (sql === 'ROLLBACK') { ro = false; pendente = null; return {rows: [], command: 'ROLLBACK'}; }
      if (sql === 'COMMIT') {
        commits++;
        if (falharCommit && falharCommit.n === commits) throw falharCommit.erro;
        if (pendente) { pendente.aplicar(); pendente = null; }
        return {rows: [], command: 'COMMIT'};
      }
      if (sql === prod.SQL_IDENTIDADE) return {rows: [identidade]};
      if (sql === comum.SQL_ESTADO) return {rows: [{...atual}]};
      if (sql === comum.SQL_CATEGORIA_103) return {rows: [{m103_linha: cat.linha}]};
      if (sql.includes('AS categorias_adicionais')) return {rows: [{...CONTAGENS}]};
      if (sql === I102) return {rows: [{integra_102: pendente ? integraNaTransacao : integra}]};
      if (sql === C102) { assert.equal(ro, false, 'migration nunca em READ ONLY'); pendente = {aplicar: () => Object.assign(atual, COMPLETA_102)}; }
      if (sql === C103) { assert.equal(ro, false, 'migration nunca em READ ONLY'); pendente = {aplicar: () => { cat.linha = 'IGUAL'; }}; }
      assert.ok(sql !== M102 && sql !== M103, 'o arquivo COM o COMMIT final nunca é enviado');
      return {rows: []};
    }
  };
  C.log = log; C.atual = atual; C.conexoes = 0;
  return C;
}
/** Cliente que não pode nem ser construído: prova de que a recusa veio ANTES de conectar. */
function nuncaConecta() {
  const N = class { constructor() { N.construido = true; throw new Error('CONECTOU'); } };
  N.construido = false;
  return N;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-102-103-prod-'));
const semDisco = () => {};
const escritas = log => log.filter(x => !x.ro && !/^(BEGIN TRANSACTION READ ONLY|ROLLBACK|COMMIT|SET LOCAL)/.test(x.sql) && !x.emTransacao);
const ALVOS_ERRADOS = [[{RENDER: undefined}, /^FORA_DO_RENDER$/], [{RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}, /^SERVICO_RECUSADO$/], [{RENDER_SERVICE_ID: undefined}, /^SERVICO_RECUSADO$/],
  [{KIDMAIS_DEPLOY_ENV: 'staging'}, /^AMBIENTE_RECUSADO$/], [{KIDMAIS_DEPLOY_ENV: undefined}, /^AMBIENTE_RECUSADO$/],
  [{DATABASE_SSL: 'false'}, /^TLS_OBRIGATORIO$/], [{DATABASE_SSL: undefined}, /^TLS_OBRIGATORIO$/],
  [{DATABASE_URL: undefined}, /^URL_RECUSADA$/], [{DATABASE_URL: 'nao-e-url'}, /^URL_RECUSADA$/],
  [{DATABASE_URL: URL_PROD.replace('kidmais_production', 'kidmais_staging_1z91')}, /^BANCO_RECUSADO$/],
  [{DATABASE_URL: URL_PROD.replace('kidmais_production', 'kidmais_manager')}, /^BANCO_RECUSADO$/],
  [{DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'dpg-daidko3m8hqs73ce4jt0-a')}, /^HOST_RECUSADO$/],
  [{DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'dpg-dak750gae00c73fudmg0-a.virginia-postgres.render.com')}, /^HOST_RECUSADO$/],
  [{DATABASE_URL: URL_PROD.replace(':5432/', ':6543/')}, /^PORTA_RECUSADA$/], [{DATABASE_URL: URL_PROD + '?sslmode=disable'}, /^CONNECTION_QUERY_REJECTED$/]];

test('sha dos 7 SQL fixados no núcleo conferem com a árvore; o plano de produção lista os mesmos arquivos e o retrato da 102', async () => {
  for (const [, arquivo, hash] of comum.ETAPAS) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), hash, arquivo);
  }
  assert.deepEqual(comum.ETAPAS.map(e => e[0]), PLANO_TUDO);
  const {saida} = await prod.principal([], {});
  assert.deepEqual(saida.arquivos.map(a => [a.arquivo, a.sha256]), comum.ETAPAS.map(e => [e[1], e[2]]));
  assert.equal(saida.retrato102.sha256, comum.RETRATO_102); assert.equal(saida.retrato102.versaoMaiorMedida, 18);
  for (const nome of ['postcheck 102', 'integridade 102']) assert.ok(ler(nome).includes(comum.RETRATO_102), nome);
  assert.ok(!saida.arquivos.some(a => a.arquivo.includes('rollback')));
});

test('trava de alvo de produção: serviço, ambiente, TLS obrigatório (certificado conforme o serviço), host, banco, porta, URL sem query', () => {
  const o = prod.alvo(ENV_PROD);
  assert.deepEqual(o.ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'});
  assert.equal(o.application_name, 'kidmais-migration-102-103-production'); assert.equal(o.connectionString, URL_PROD);
  assert.equal(prod.alvo({...ENV_PROD, DATABASE_SSL_REJECT_UNAUTHORIZED: undefined}).ssl.rejectUnauthorized, true);
  for (const [delta, erro] of ALVOS_ERRADOS) assert.throws(() => prod.alvo({...ENV_PROD, ...delta}), e => erro.test(e.message), JSON.stringify(delta));
  // Mensagens só com o código: nunca URL, senha ou host.
  for (const delta of [{DATABASE_URL: URL_PROD + '?password=SEGREDO'}, {DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'host-SEGREDO')}]) {
    let msg = ''; try { prod.alvo({...ENV_PROD, ...delta}); } catch (e) { msg = String(e.message); }
    assert.match(msg, /^[A-Z_]+$/); assert.ok(!msg.includes('SEGREDO') && !msg.includes('SENHA_FALSA'));
  }
  // Cruzamento: o adaptador de staging recusa o ambiente de produção e vice-versa.
  assert.throws(() => stg.alvo(ENV_PROD), /SERVICO_RECUSADO/);
  assert.throws(() => prod.alvo(ENV_STG), /SERVICO_RECUSADO/);
  assert.deepEqual(prod.ALVO, {servico: 'srv-dak77m2d0e5s73b8rkkg', host: 'dpg-dak750gae00c73fudmg0-a', database: 'kidmais_production', port: 5432});
  assert.equal(prod.DIR, '/opt/render/project/src/data/saloes-102-103-producao'); assert.notEqual(prod.DIR, stg.DIR);
});

test('alvo errado ou variável faltando: CONFERIR e APLICAR recusam (lançam, código 1 na CLI) ANTES de construir o cliente e de tocar o disco', async () => {
  for (const [delta, erro] of ALVOS_ERRADOS) {
    const env = {...ENV_PROD, ...delta};
    for (const argv of [['--conferir-102-103'], ['--aplicar-102-103-autorizado', '--backup', BACKUP]]) {
      const N = nuncaConecta(); const dir = path.join(os.tmpdir(), 'nao-criado-102-103-prod');
      await assert.rejects(prod.principal(argv, env, {Client: N, dir, disco: () => assert.fail('DISCO_CONSULTADO')}), e => erro.test(e.message), JSON.stringify(delta) + argv[0]);
      assert.equal(N.construido, false, 'cliente não construído'); assert.equal(fs.existsSync(dir), false, 'nada no disco');
    }
  }
  await assert.rejects(prod.principal(['--conferir-102-103'], ENV_STG, {Client: nuncaConecta()}), /SERVICO_RECUSADO/);
  await assert.rejects(prod.principal(['--aplicar-102-103-autorizado'], ENV_PROD, {Client: nuncaConecta()}), /BACKUP_OBRIGATORIO/);
  await assert.rejects(prod.principal(['--aplicar-102-103-autorizado', '--backup', 'x;rm'], ENV_PROD, {Client: nuncaConecta()}), /BACKUP_INVALIDO/);
  await assert.rejects(prod.principal(['--conferir-104-106'], ENV_PROD, {Client: nuncaConecta()}), /ARGUMENTOS_RECUSADOS/);
});

test('identidade provada pelo servidor: banco de produção, TLS ativo 1.2/1.3 e servidor em rede privada; disco persistente', async () => {
  assert.deepEqual(prod.identidade(ID_PROD), CONEXAO);
  assert.equal(prod.identidade({...ID_PROD, tls_versao: 'TLSv1.2'}).tlsVersao, 'TLSv1.2');
  for (const [delta, erro] of [[{db: 'kidmais_staging_1z91'}, /BANCO_DIVERGENTE/], [{tls: false}, /SEM_TLS/], [{tls: null}, /SEM_TLS/],
    [{tls_versao: 'TLSv1.1'}, /TLS_VERSAO_RECUSADA/], [{servidor_privado: false}, /SERVIDOR_FORA_DA_REDE_PRIVADA/]])
    assert.throws(() => prod.identidade({...ID_PROD, ...delta}), erro);
  assert.throws(() => prod.identidade(undefined), /BANCO_DIVERGENTE/);
  assert.match(prod.SQL_IDENTIDADE, /pg_stat_ssl/); assert.match(prod.SQL_IDENTIDADE, /inet_server_addr\(\)/);
  assert.throws(() => prod.exigirDisco(path.join(os.tmpdir(), 'nao-existe-102-103-prod')), /DISCO_PERSISTENTE_AUSENTE/);
  const st = (dev, extra = {}) => ({dev, isDirectory: () => true, isSymbolicLink: () => false, ...extra});
  assert.doesNotThrow(() => prod.exigirDisco('/d/data', p => (p === '/d/data' ? st(2) : st(1))));
  assert.throws(() => prod.exigirDisco('/d/data', () => st(1)), /DISCO_PERSISTENTE_AUSENTE/, 'mesmo dispositivo do pai = disco efêmero');
  assert.throws(() => prod.exigirDisco('/d/data', p => (p === '/d/data' ? st(2, {isSymbolicLink: () => true}) : st(1))), /DISCO_PERSISTENTE_AUSENTE/);
  // Identidade de staging (ou sem TLS) numa conexão de produção: FALHA (código 2), sem ler o estado.
  for (const id of [{...ID_PROD, db: 'kidmais_staging_1z91'}, {...ID_PROD, tls: false}, {...ID_PROD, servidor_privado: false}]) {
    const C = clienteFalso({identidade: id});
    const x = await prod.principal(['--conferir-102-103'], ENV_PROD, {Client: C});
    assert.equal(x.codigo, 2); assert.equal(x.saida.resultado, 'FALHA'); assert.ok(!JSON.stringify(x).includes('SENHA_FALSA'));
    assert.ok(!C.log.some(l => l.sql === comum.SQL_ESTADO), 'estado não lido');
    const dir = tmp();
    try {
      const A = clienteFalso({identidade: id});
      const a = await prod.principal(['--aplicar-102-103-autorizado', '--backup', BACKUP], ENV_PROD, {Client: A, dir, disco: semDisco});
      assert.equal(a.codigo, 2); assert.deepEqual(a.saida.commits, {}); assert.deepEqual(escritas(A.log), []);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('conferência de produção: só leitura, nada no disco; ausente = prechecks (PRONTA); completa = integridade/postcheck (JA_APLICADA)', async () => {
  const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
  fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
  try {
    const Pronta = clienteFalso();
    const x = await prod.principal(['--conferir-102-103'], ENV_PROD, {Client: Pronta});
    assert.equal(x.codigo, 0); assert.equal(x.saida.resultado, 'PRONTA_PARA_APLICAR', JSON.stringify(x.saida));
    assert.deepEqual(x.saida.conexao, CONEXAO); assert.deepEqual(x.saida.plano, PLANO_TUDO);
    assert.deepEqual(x.saida.checks, {'precheck 102': 'PASS', 'precheck 103': 'PASS'}); assert.deepEqual(x.saida.contagens, CONTAGENS);
    assert.deepEqual(escritas(Pronta.log), []); assert.ok(!Pronta.log.some(l => l.sql === C102 || l.sql === C103));
    const leituras = Pronta.log.filter(l => /^SELECT|^DO|^--/.test(l.sql));
    assert.ok(leituras.length > 0 && leituras.every(l => l.ro), 'toda consulta dentro de READ ONLY');
    const Aplicada = clienteFalso({inicial: estado(COMPLETA_102), linha: 'IGUAL'});
    const j = await prod.principal(['--conferir-102-103'], ENV_PROD, {Client: Aplicada});
    assert.equal(j.codigo, 0); assert.equal(j.saida.resultado, 'JA_APLICADA_INTEGRIDADE_PASS', JSON.stringify(j.saida));
    assert.deepEqual(j.saida.checks, {'integridade 102': 'PASS', 'postcheck 103': 'PASS'});
    assert.ok(Aplicada.log.some(l => l.ro && l.sql === I102)); assert.deepEqual(escritas(Aplicada.log), []);
  } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
  assert.deepEqual(gravacoes, [], 'a conferência não grava arquivos');
});

test('produção recusa (CONFERIR código 3, APLICAR código 2, nada escrito): 102 parcial, 098 presente, PostgreSQL fora do 18, SERVICOS divergente, retrato divergente', async () => {
  for (const [opcoes, motivo] of [[{inicial: estado({m102_tabelas: 2})}, /APLICACAO_PARCIAL_102/], [{inicial: estado({m102_colunas: 13})}, /APLICACAO_PARCIAL_102/],
    [{inicial: estado({...COMPLETA_102, m102_funcoes: 8})}, /APLICACAO_PARCIAL_102/],
    [{inicial: estado({com_098: true})}, /COM_098_102/], [{inicial: estado({versao_pg: 170005})}, /VERSAO_PG_NAO_MEDIDA_102 170005/],
    [{inicial: estado({d102: false})}, /DEPENDENCIA_AUSENTE_102 093/], [{inicial: estado({dono_102: false})}, /SEM_PRIVILEGIO_102 DONO/],
    [{linha: 'DIVERGENTE'}, /CATEGORIA_DIVERGENTE_103/], [{inicial: estado(COMPLETA_102), linha: 'IGUAL', integra: false}, /INTEGRIDADE_102 false/]]) {
    const C = clienteFalso(opcoes);
    const x = await prod.principal(['--conferir-102-103'], ENV_PROD, {Client: C});
    assert.equal(x.codigo, 3, String(motivo) + JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'RECUSARIA'); assert.match(x.saida.motivo, motivo);
    assert.deepEqual(escritas(C.log), []);
    const dir = tmp();
    try {
      const A = clienteFalso(opcoes);
      const a = await prod.principal(['--aplicar-102-103-autorizado', '--backup', BACKUP], ENV_PROD, {Client: A, dir, disco: semDisco});
      assert.equal(a.codigo, 2, String(motivo)); assert.match(a.saida.falha.mensagem, motivo); assert.deepEqual(a.saida.commitadas, []);
      assert.deepEqual(escritas(A.log), [], 'aplicação recusa antes de qualquer migration');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
  // 098 e versão só importam com a 102 pendente (regra do núcleo, igual em staging).
  const C = clienteFalso({inicial: estado({...COMPLETA_102, com_098: true, versao_pg: 170005}), linha: 'IGUAL'});
  assert.equal((await prod.principal(['--conferir-102-103'], ENV_PROD, {Client: C})).saida.resultado, 'JA_APLICADA_INTEGRIDADE_PASS');
});

test('aplicação em produção: disco exigido antes de conectar, corpos sem COMMIT, verificações na transação, marcador de produção exclusivo', async () => {
  const N = nuncaConecta();
  await assert.rejects(prod.executar({env: ENV_PROD, backup: BACKUP, dir: tmp(), Client: N}), /DISCO_PERSISTENTE_AUSENTE/);
  assert.equal(N.construido, false, 'disco padrão do adaptador (ausente fora do Render) recusa antes de conectar');
  const dir = tmp();
  try {
    const C = clienteFalso();
    const x = await prod.principal(['--aplicar-102-103-autorizado', '--backup', BACKUP], ENV_PROD, {Client: C, dir, disco: semDisco});
    assert.equal(x.codigo, 0); assert.equal(x.saida.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(x.saida));
    assert.deepEqual(x.saida.etapas, PLANO_TUDO); assert.deepEqual(x.saida.commits, {102: 'CONFIRMADO', 103: 'CONFIRMADO'});
    assert.deepEqual(escritas(C.log).map(l => l.sql), [C102, C103], 'só os corpos (sem COMMIT) escrevem, na ordem');
    const i = C.log.findIndex(l => l.sql === C102), iCommit = C.log.findIndex((l, k) => k > i && l.sql === 'COMMIT');
    const k = C.log.findIndex((l, n) => n > i && l.sql === I102);
    assert.ok(k > i && k < iCommit && C.log[k].emTransacao && !C.log[k].ro, 'integridade (retrato) da 102 dentro da transação, antes do COMMIT');
    const m = JSON.parse(fs.readFileSync(x.saida.marcador, 'utf8'));
    assert.equal(path.basename(x.saida.marcador), 'migration-102-103.json');
    assert.equal(m.ambiente, 'production'); assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.backup, BACKUP); assert.deepEqual(m.conexao, CONEXAO);
    assert.ok(!fs.readFileSync(x.saida.marcador, 'utf8').includes('SENHA_FALSA'));
    await assert.rejects(prod.principal(['--aplicar-102-103-autorizado', '--backup', BACKUP], ENV_PROD, {Client: clienteFalso(), dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  // Já aplicadas: nenhuma escrita.
  const dir2 = tmp();
  try {
    const J = clienteFalso({inicial: estado(COMPLETA_102), linha: 'IGUAL'});
    const r = await prod.executar({env: ENV_PROD, backup: BACKUP, dir: dir2, Client: J, disco: semDisco});
    assert.equal(r.resultado, 'JA_APLICADA_INTEGRIDADE_PASS'); assert.deepEqual(escritas(J.log), []); assert.deepEqual(r.commits, {});
  } finally { fs.rmSync(dir2, {recursive: true, force: true}); }
});

test('falhas na aplicação em produção: retrato divergente na transação = nada confirmado; COMMIT 40003/sem resposta = INDETERMINADO; recusa = desfeita; código 2', async () => {
  for (const [rotulo, opcoes, commits] of [
    ['retrato divergente na transação', {integraNaTransacao: false}, {102: 'NAO_COMMITADA'}],
    ['COMMIT 102 40003', {falharCommit: {n: 1, erro: erroPg('40003')}}, {102: 'INDETERMINADO'}],
    ['COMMIT 102 sem resposta', {falharCommit: {n: 1, erro: new Error('Connection terminated unexpectedly')}}, {102: 'INDETERMINADO'}],
    ['COMMIT 102 recusado', {falharCommit: {n: 1, erro: erroPg('23503')}}, {102: 'DESFEITA_PELO_SERVIDOR'}],
    ['COMMIT 103 40003', {falharCommit: {n: 2, erro: erroPg('40003')}}, {102: 'CONFIRMADO', 103: 'INDETERMINADO'}]]) {
    const dir = tmp();
    try {
      const C = clienteFalso(opcoes);
      const x = await prod.principal(['--aplicar-102-103-autorizado', '--backup', BACKUP], ENV_PROD, {Client: C, dir, disco: semDisco});
      assert.equal(x.codigo, 2, rotulo); assert.equal(x.saida.resultado, 'FALHA', rotulo); assert.deepEqual(x.saida.commits, commits, rotulo);
      assert.match(x.saida.reconciliar, /--conferir-102-103/);
      const m = JSON.parse(fs.readFileSync(x.saida.marcador, 'utf8'));
      assert.equal(m.situacao, 'FALHA'); assert.equal(m.ambiente, 'production'); assert.deepEqual(m.commits, commits, rotulo + ' (marcador)');
      if (!('103' in commits)) assert.ok(!C.log.some(l => l.sql === C103), rotulo + ': 103 não roda');
      await assert.rejects(prod.principal(['--aplicar-102-103-autorizado', '--backup', BACKUP], ENV_PROD, {Client: clienteFalso(), dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('plano de produção sem conexão: alvo e registro de produção, ordem de produção (PITR de production, autorização própria); staging mantém a dele', async () => {
  const N = nuncaConecta();
  const {codigo, saida} = await prod.principal([], {}, {Client: N});
  assert.equal(codigo, 0); assert.equal(N.construido, false); assert.equal(saida.conecta, false); assert.equal(saida.ambiente, 'production');
  assert.deepEqual(saida.alvo, prod.ALVO); assert.equal(saida.registro, prod.DIR);
  assert.deepEqual(saida.ordem, [...prod.ORDEM]); assert.deepEqual(prod.plano().ordem, [...prod.ORDEM]);
  assert.ok(saida.ordem.indexOf('--conferir-102-103: PRONTA_PARA_APLICAR') < saida.ordem.indexOf('--aplicar-102-103-autorizado'));
  assert.ok(saida.ordem.some(o => /PITR do PostgreSQL de production/.test(o) && /export lógico NÃO serve/.test(o)));
  assert.ok(saida.ordem.includes('autorização de Felipe para a 102/103 em production'));
  assert.ok(saida.ordem.some(o => /imediatamente antes/.test(o)) && saida.ordem.some(o => /janela combinada/.test(o) && /ACCESS EXCLUSIVE em agenda_saloes/.test(o)));
  assert.ok(saida.ordem.some(o => /SEM a 098/.test(o)));
  assert.ok(!saida.ordem.some(o => /staging/.test(o)), 'nada da ordem de staging');
  // O resto do plano é o do núcleo, sem mudança.
  const s = (await stg.principal([], {})).saida;
  for (const k of ['arquivos', 'retrato102', 'modos', 'preRequisitos', 'paradas', 'recuperacao', 'nuncaExecuta']) assert.deepEqual(saida[k], s[k], k);
  assert.ok(s.ordem.some(o => /PostgreSQL de staging/.test(o)), 'staging mantém a ordem dele');
  assert.ok(saida.nuncaExecuta.includes('down 102') && saida.nuncaExecuta.includes('down 103'));
  assert.deepEqual(prod.CODIGO, stg.CODIGO);
});
