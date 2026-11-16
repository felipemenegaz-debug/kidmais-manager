/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 109 de PRODUÇÃO com cliente simulado (o mesmo desenho da suíte de staging: só CONFIRMA no COMMIT e descarta
// no ROLLBACK): trava de alvo e identidade de produção (TLS obrigatório, identidade provada no servidor), disco, cruzamento
// com staging, variável faltando recusa ANTES de conectar, estado pelo contrato TypeScript do cron (075 = pendente, 109 =
// completa, qualquer outro = divergente com os nomes), sessões `kidmais-renovacao*` ativas, sha dos 3 SQL e do contrato,
// aplicação com marcador próprio de produção, COMMIT indeterminado e a ordem de produção no plano (B-27: sem criar nem
// retomar cron). O núcleo (scripts/migration-109-comum.cjs) é o de staging, intacto. Sem rede nem banco. O contrato é
// TypeScript: rodar com --experimental-strip-types quando o Node não o fizer por padrão.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {createHash} = require('node:crypto');
const comum = require('./migration-109-comum.cjs');
const {lerRevisado} = require('./migration-092-094-comum.cjs');
const prod = require('./migration-109-production.cjs');
const stg = require('./migration-109-staging.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_PROD = 'postgresql://usuario:SENHA_FALSA@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production';
const ENV_PROD = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'false', DATABASE_URL: URL_PROD});
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false',
  DATABASE_URL: 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'});
const ID_PROD = {db: 'kidmais_production', tls: true, tls_versao: 'TLSv1.3', servidor_privado: true};
const CONEXAO = {banco: 'kidmais_production', tls: true, tlsVersao: 'TLSv1.3', servidorPrivado: true};
const BACKUP = 'PITR 2026-11-12T03:00Z production';
const CONFERIR = ['--conferir-109'], APLICAR = ['--aplicar-109-autorizado', '--backup', BACKUP];
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
/** Retrato com uma deriva (corpo de função trocado), para o caso divergente; e uma 109 pela metade (uma função a menos). */
const derivado = r => ({...r, funcoes: r.funcoes.map((f, i) => i === 0 ? {...f, sha256: '0'.repeat(64)} : f)});

/** Cliente simulado transacional (como na suíte de staging); a identidade é a linha de prod.SQL_IDENTIDADE. */
function clienteFalso({inicial = estado(), retrato = '075', identidade = ID_PROD, falharEm, erro, falharCommit, retratoNaTransacao} = {}) {
  const log = []; let ro = false, pendente = null, commits = 0;
  const atual = {...inicial, retrato: typeof retrato === 'string' ? (retrato === '109' ? R.RETRATO_109 : R.RETRATO_075) : retrato, aplicada: retrato === '109'};
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql, params) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') ro = true;
      log.push({sql, ro, emTransacao: pendente !== null});
      if (falharEm && sql.includes(falharEm)) throw erro ?? erroPg('55P03', 'falha simulada em ' + falharEm);
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
      if (sql === comum.SQL_ESTADO) return {rows: [{...atual, retrato: undefined, aplicada: undefined}]};
      if (sql === "SELECT current_setting('search_path') AS v") return {rows: [{v: 'public, pg_catalog'}]};
      if (sql.startsWith("SELECT set_config('search_path'")) { if (params) assert.equal(params[0], 'public, pg_catalog'); return {rows: []}; }
      if (sql === SCHEMA.SQL_RETRATO) return {rows: [{retrato: pendente ? pendente.retrato : atual.retrato}]};
      if (sql.startsWith('SELECT estado, count(*)')) return {rows: [...POR_ESTADO]};
      if (sql.includes('substitui_id IS NOT NULL')) return {rows: [{n: 0}]};
      if (sql === C109) {
        assert.equal(ro, false, 'migration nunca em READ ONLY');
        const r109 = retratoNaTransacao ?? R.RETRATO_109;
        pendente = {retrato: r109, aplicar: () => { atual.retrato = r109; atual.aplicada = true; }};
      }
      assert.notEqual(sql, M109, 'o arquivo COM o COMMIT final nunca é enviado');
      assert.ok(sql !== PRE109 && sql !== POS109, 'precheck/postcheck vão sem a própria moldura');
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
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-109-prod-'));
const semDisco = () => {};
// Configuração de sessão (prazo de execução) não é escrita de dados.
const LEITURA = /^(BEGIN TRANSACTION READ ONLY|ROLLBACK|COMMIT|SET LOCAL|SELECT |SET statement_timeout = |RESET statement_timeout$)/;
const escritas = log => log.filter(x => !x.ro && !LEITURA.test(x.sql) && !x.emTransacao);
const ALVOS_ERRADOS = [[{RENDER: undefined}, /^FORA_DO_RENDER$/], [{RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}, /^SERVICO_RECUSADO$/], [{RENDER_SERVICE_ID: undefined}, /^SERVICO_RECUSADO$/],
  [{KIDMAIS_DEPLOY_ENV: 'staging'}, /^AMBIENTE_RECUSADO$/], [{KIDMAIS_DEPLOY_ENV: undefined}, /^AMBIENTE_RECUSADO$/],
  [{DATABASE_SSL: 'false'}, /^TLS_OBRIGATORIO$/], [{DATABASE_SSL: undefined}, /^TLS_OBRIGATORIO$/],
  [{DATABASE_URL: undefined}, /^URL_RECUSADA$/], [{DATABASE_URL: 'nao-e-url'}, /^URL_RECUSADA$/],
  [{DATABASE_URL: URL_PROD.replace('kidmais_production', 'kidmais_staging_1z91')}, /^BANCO_RECUSADO$/],
  [{DATABASE_URL: URL_PROD.replace('kidmais_production', 'kidmais_manager')}, /^BANCO_RECUSADO$/],
  [{DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'dpg-daidko3m8hqs73ce4jt0-a')}, /^HOST_RECUSADO$/],
  [{DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'dpg-dak750gae00c73fudmg0-a.virginia-postgres.render.com')}, /^HOST_RECUSADO$/],
  [{DATABASE_URL: URL_PROD.replace(':5432/', ':6543/')}, /^PORTA_RECUSADA$/], [{DATABASE_URL: URL_PROD + '?sslmode=disable'}, /^CONNECTION_QUERY_REJECTED$/]];

test('sha dos 3 SQL e do contrato TypeScript fixados no núcleo conferem com a árvore; o plano de produção lista os mesmos; postcheck = gerado do contrato', async () => {
  const sha = a => createHash('sha256').update(fs.readFileSync(path.join(raiz, a), 'utf8').replace(/\r\n/g, '\n')).digest('hex');
  for (const [, arquivo, hash] of comum.ETAPAS) assert.equal(sha(arquivo), hash, arquivo);
  for (const [arquivo, hash] of comum.CONTRATO) assert.equal(sha(arquivo), hash, arquivo);
  assert.deepEqual(comum.CONTRATO.map(c => c[0]), ['lib/assinatura/renovacao-schema.ts', 'lib/assinatura/renovacao-schema-retratos.ts']);
  const {saida} = await prod.principal([], {});
  assert.deepEqual(saida.arquivos.map(a => [a.arquivo, a.sha256]), [...comum.ETAPAS.map(e => [e[1], e[2]]), ...comum.CONTRATO]);
  assert.equal(POS109, SCHEMA.postcheck109(), 'postcheck = gerado do contrato');
  assert.ok(!saida.arquivos.some(a => a.arquivo.includes('rollback')));
});

test('trava de alvo de produção: serviço, ambiente, TLS obrigatório (certificado conforme o serviço), host, banco, porta, URL sem query', () => {
  const o = prod.alvo(ENV_PROD);
  assert.deepEqual(o.ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'});
  assert.equal(o.application_name, 'kidmais-migration-109-production'); assert.equal(o.connectionString, URL_PROD);
  assert.ok(!o.application_name.startsWith(comum.PREFIXO_RENOVACAO), 'o próprio aplicador não conta como sessão da renovação');
  assert.equal(prod.alvo({...ENV_PROD, DATABASE_SSL_REJECT_UNAUTHORIZED: undefined}).ssl.rejectUnauthorized, true);
  for (const [delta, erro] of ALVOS_ERRADOS) assert.throws(() => prod.alvo({...ENV_PROD, ...delta}), e => erro.test(e.message), JSON.stringify(delta));
  for (const delta of [{DATABASE_URL: URL_PROD + '?password=SEGREDO'}, {DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'host-SEGREDO')}]) {
    let msg = ''; try { prod.alvo({...ENV_PROD, ...delta}); } catch (e) { msg = String(e.message); }
    assert.match(msg, /^[A-Z_]+$/); assert.ok(!msg.includes('SEGREDO') && !msg.includes('SENHA_FALSA'));
  }
  assert.throws(() => stg.alvo(ENV_PROD), /SERVICO_RECUSADO/);
  assert.throws(() => prod.alvo(ENV_STG), /SERVICO_RECUSADO/);
  assert.deepEqual(prod.ALVO, {servico: 'srv-dak77m2d0e5s73b8rkkg', host: 'dpg-dak750gae00c73fudmg0-a', database: 'kidmais_production', port: 5432});
  assert.equal(prod.DIR, '/opt/render/project/src/data/renovacao-109-producao'); assert.notEqual(prod.DIR, stg.DIR);
});

test('alvo errado ou variável faltando: CONFERIR e APLICAR recusam (lançam, código 1 na CLI) ANTES de construir o cliente e de tocar o disco', async () => {
  for (const [delta, erro] of ALVOS_ERRADOS) {
    const env = {...ENV_PROD, ...delta};
    for (const argv of [CONFERIR, APLICAR]) {
      const N = nuncaConecta(); const dir = path.join(os.tmpdir(), 'nao-criado-109-prod');
      await assert.rejects(prod.principal(argv, env, {Client: N, dir, disco: () => assert.fail('DISCO_CONSULTADO')}), e => erro.test(e.message), JSON.stringify(delta) + argv[0]);
      assert.equal(N.construido, false, 'cliente não construído'); assert.equal(fs.existsSync(dir), false, 'nada no disco');
    }
  }
  await assert.rejects(prod.principal(CONFERIR, ENV_STG, {Client: nuncaConecta()}), /SERVICO_RECUSADO/);
  await assert.rejects(prod.principal(['--aplicar-109-autorizado'], ENV_PROD, {Client: nuncaConecta()}), /BACKUP_OBRIGATORIO/);
  await assert.rejects(prod.principal(['--aplicar-109-autorizado', '--backup', 'x;rm'], ENV_PROD, {Client: nuncaConecta()}), /BACKUP_INVALIDO/);
  await assert.rejects(prod.principal(['--conferir-105'], ENV_PROD, {Client: nuncaConecta()}), /ARGUMENTOS_RECUSADOS/);
});

test('identidade provada pelo servidor: banco de produção, TLS ativo 1.2/1.3 e servidor em rede privada; disco persistente', async () => {
  assert.deepEqual(prod.identidade(ID_PROD), CONEXAO);
  assert.equal(prod.identidade({...ID_PROD, tls_versao: 'TLSv1.2'}).tlsVersao, 'TLSv1.2');
  for (const [delta, erro] of [[{db: 'kidmais_staging_1z91'}, /BANCO_DIVERGENTE/], [{tls: false}, /SEM_TLS/], [{tls: null}, /SEM_TLS/],
    [{tls_versao: 'TLSv1.1'}, /TLS_VERSAO_RECUSADA/], [{servidor_privado: false}, /SERVIDOR_FORA_DA_REDE_PRIVADA/]])
    assert.throws(() => prod.identidade({...ID_PROD, ...delta}), erro);
  assert.throws(() => prod.identidade(undefined), /BANCO_DIVERGENTE/);
  assert.match(prod.SQL_IDENTIDADE, /pg_stat_ssl/); assert.match(prod.SQL_IDENTIDADE, /inet_server_addr\(\)/);
  assert.throws(() => prod.exigirDisco(path.join(os.tmpdir(), 'nao-existe-109-prod')), /DISCO_PERSISTENTE_AUSENTE/);
  const st = (dev, extra = {}) => ({dev, isDirectory: () => true, isSymbolicLink: () => false, ...extra});
  assert.doesNotThrow(() => prod.exigirDisco('/d/data', p => (p === '/d/data' ? st(2) : st(1))));
  assert.throws(() => prod.exigirDisco('/d/data', () => st(1)), /DISCO_PERSISTENTE_AUSENTE/, 'mesmo dispositivo do pai = disco efêmero');
  assert.throws(() => prod.exigirDisco('/d/data', p => (p === '/d/data' ? st(2, {isSymbolicLink: () => true}) : st(1))), /DISCO_PERSISTENTE_AUSENTE/);
  for (const id of [{...ID_PROD, db: 'kidmais_staging_1z91'}, {...ID_PROD, tls: false}, {...ID_PROD, servidor_privado: false}]) {
    const C = clienteFalso({identidade: id});
    const x = await prod.principal(CONFERIR, ENV_PROD, {Client: C});
    assert.equal(x.codigo, 2); assert.equal(x.saida.resultado, 'FALHA'); assert.ok(!JSON.stringify(x).includes('SENHA_FALSA'));
    assert.ok(!C.log.some(l => l.sql === comum.SQL_ESTADO), 'estado não lido');
  }
});

test('conferência de produção pelo contrato do cron: 075 = precheck (PRONTA); 109 = capacidade (JA_APLICADA); só leitura, nada no disco', async () => {
  const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
  fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
  try {
    const Pronta = clienteFalso();
    const x = await prod.principal(CONFERIR, ENV_PROD, {Client: Pronta});
    assert.equal(x.codigo, 0); assert.equal(x.saida.resultado, 'PRONTA_PARA_APLICAR', JSON.stringify(x.saida));
    assert.deepEqual(x.saida.conexao, CONEXAO); assert.deepEqual(x.saida.plano, PLANO_TUDO); assert.deepEqual(x.saida.checks, {'precheck 109': 'PASS'});
    assert.equal(x.saida.estado.capacidade, '075', 'production em 075 confere o conjunto 075');
    assert.deepEqual(x.saida.contagens, {total: 7, porEstado: {CANCELADA: 5, PENDENTE: 1, REGULAR: 1}});
    assert.deepEqual(escritas(Pronta.log), []);
    const leituras = Pronta.log.filter(l => /^SELECT|^DO|^WITH/.test(l.sql));
    assert.ok(leituras.length > 0 && leituras.every(l => l.ro), 'toda consulta dentro de READ ONLY');
    assert.ok(Pronta.log.some(l => l.ro && l.sql === SCHEMA.SQL_RETRATO), 'o retrato do contrato foi lido');
    assert.ok(Pronta.log.some(l => l.ro && l.sql === CORPO_PRE)); assert.ok(!Pronta.log.some(l => l.sql === C109));
    const Aplicada = clienteFalso({retrato: '109'});
    const j = await prod.principal(CONFERIR, ENV_PROD, {Client: Aplicada});
    assert.equal(j.codigo, 0); assert.equal(j.saida.resultado, 'JA_APLICADA_CAPACIDADE_PASS', JSON.stringify(j.saida));
    assert.deepEqual(j.saida.checks, {'capacidade 109': 'PASS'}); assert.equal(j.saida.contagens.comSubstituto, 0);
    assert.deepEqual(escritas(Aplicada.log), []);
    // Já aplicada: sessão da renovação ativa não impede a conferência (a guarda vale só com a 109 pendente).
    const ComCron = clienteFalso({retrato: '109', inicial: estado({sessoes_renovacao: 2})});
    assert.equal((await prod.principal(CONFERIR, ENV_PROD, {Client: ComCron})).saida.resultado, 'JA_APLICADA_CAPACIDADE_PASS');
  } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
  assert.deepEqual(gravacoes, [], 'a conferência não grava arquivos');
});

test('produção recusa (CONFERIR 3, APLICAR 2, nada escrito): retrato divergente (075 com deriva ou 109 pela metade), sessão kidmais-renovacao* ativa, privilégio e tabela ausente', async () => {
  for (const [opcoes, motivo] of [[{retrato: () => derivado(R.RETRATO_075)}, /RETRATO_DIVERGENTE_109 funcoes:/], [{retrato: () => derivado(R.RETRATO_109)}, /RETRATO_DIVERGENTE_109 funcoes:/],
    [{inicial: estado({sessoes_renovacao: 1})}, /RENOVACAO_EM_EXECUCAO 1/], [{inicial: estado({sessoes_renovacao: 3})}, /RENOVACAO_EM_EXECUCAO 3/],
    [{inicial: estado({dono: false})}, /SEM_PRIVILEGIO_109 DONO_RENOVACOES/], [{inicial: estado({tabela: false})}, /TABELA_AUSENTE assinatura_renovacoes/]]) {
    const o = () => ({...opcoes, retrato: typeof opcoes.retrato === 'function' ? opcoes.retrato() : opcoes.retrato});
    const C = clienteFalso(o());
    const x = await prod.principal(CONFERIR, ENV_PROD, {Client: C});
    assert.equal(x.codigo, 3, String(motivo) + JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'RECUSARIA'); assert.match(x.saida.motivo, motivo);
    assert.ok(!C.log.some(l => l.sql === CORPO_PRE || l.sql.startsWith('SELECT estado, count(*)')), 'nada lido além do catálogo');
    assert.deepEqual(escritas(C.log), []);
    const dir = tmp();
    try {
      const A = clienteFalso(o());
      const a = await prod.principal(APLICAR, ENV_PROD, {Client: A, dir, disco: semDisco});
      assert.equal(a.codigo, 2, String(motivo)); assert.match(a.saida.falha.mensagem, motivo); assert.deepEqual(a.saida.commits, {});
      assert.deepEqual(escritas(A.log), [], 'aplicação recusa antes da migration'); assert.ok(!A.log.some(l => l.sql === C109));
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('aplicação em produção: disco exigido antes de conectar, corpo sem COMMIT, postcheck e capacidade 109 na transação, marcador de produção exclusivo', async () => {
  const N = nuncaConecta();
  await assert.rejects(prod.executar({env: ENV_PROD, backup: BACKUP, dir: tmp(), Client: N}), /DISCO_PERSISTENTE_AUSENTE/);
  assert.equal(N.construido, false, 'disco padrão do adaptador (ausente fora do Render) recusa antes de conectar');
  const dir = tmp();
  try {
    const C = clienteFalso();
    const x = await prod.principal(APLICAR, ENV_PROD, {Client: C, dir, disco: semDisco});
    assert.equal(x.codigo, 0); assert.equal(x.saida.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(x.saida));
    assert.deepEqual(x.saida.etapas, PLANO_TUDO); assert.deepEqual(x.saida.commits, {109: 'CONFIRMADO'});
    assert.equal(x.saida.estadoDepois.capacidade, '109'); assert.deepEqual(x.saida.contagensDepois.porEstado, x.saida.contagensAntes.porEstado);
    assert.deepEqual(escritas(C.log).map(l => l.sql), [C109], 'só o corpo (sem COMMIT) escreve');
    const i = C.log.findIndex(l => l.sql === C109), iCommit = C.log.findIndex((l, k) => k > i && l.sql === 'COMMIT');
    for (const v of [CORPO_POS, SCHEMA.SQL_RETRATO]) {
      const k = C.log.findIndex((l, n) => n > i && l.sql === v);
      assert.ok(k > i && k < iCommit && C.log[k].emTransacao && !C.log[k].ro, 'verificação dentro da transação, antes do COMMIT');
    }
    assert.deepEqual(C.log[i - 1], {sql: "SET statement_timeout = '60s'", ro: false, emTransacao: false}, 'prazo de execução imediatamente antes do corpo');
    const m = JSON.parse(fs.readFileSync(x.saida.marcador, 'utf8'));
    assert.equal(path.basename(x.saida.marcador), 'migration-109.json');
    assert.equal(m.ambiente, 'production'); assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.backup, BACKUP); assert.deepEqual(m.conexao, CONEXAO);
    assert.deepEqual(m.etapas.find(e => e.nome === 'migration 109').antesDoCommit, {'postcheck 109': 'PASS', 'capacidade 109': 'PASS'});
    assert.ok(!fs.readFileSync(x.saida.marcador, 'utf8').includes('SENHA_FALSA'));
    await assert.rejects(prod.principal(APLICAR, ENV_PROD, {Client: clienteFalso(), dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  const dir2 = tmp();
  try {
    const J = clienteFalso({retrato: '109'});
    const r = await prod.executar({env: ENV_PROD, backup: BACKUP, dir: dir2, Client: J, disco: semDisco});
    assert.equal(r.resultado, 'JA_APLICADA_CAPACIDADE_PASS'); assert.deepEqual(r.etapas, ['capacidade 109']); assert.deepEqual(escritas(J.log), []); assert.deepEqual(r.commits, {});
  } finally { fs.rmSync(dir2, {recursive: true, force: true}); }
});

test('falhas na aplicação em produção: capacidade divergente na transação = NAO_COMMITADA; COMMIT 40003/sem resposta = INDETERMINADO; recusa e ROLLBACK respondido = desfeita; código 2', async () => {
  for (const [rotulo, opcoes, commit] of [
    ['retrato que a migration deixou ≠ 109', {retratoNaTransacao: () => derivado(R.RETRATO_109)}, 'NAO_COMMITADA'],
    ['corpo (lock)', {falharEm: 'LOCK TABLE public.assinatura_renovacoes', erro: erroPg('55P03')}, 'NAO_COMMITADA'],
    ['COMMIT 40003', {falharCommit: {n: 1, erro: erroPg('40003')}}, 'INDETERMINADO'],
    ['COMMIT sem resposta', {falharCommit: {n: 1, erro: new Error('Connection terminated unexpectedly')}}, 'INDETERMINADO'],
    ['COMMIT recusado', {falharCommit: {n: 1, erro: erroPg('23514')}}, 'DESFEITA_PELO_SERVIDOR'],
    ['COMMIT respondido como ROLLBACK', {falharCommit: {n: 1, rollback: true}}, 'DESFEITA_PELO_SERVIDOR']]) {
    const dir = tmp();
    try {
      const C = clienteFalso({...opcoes, retratoNaTransacao: opcoes.retratoNaTransacao?.()});
      const x = await prod.principal(APLICAR, ENV_PROD, {Client: C, dir, disco: semDisco});
      assert.equal(x.codigo, 2, rotulo + JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'FALHA', rotulo); assert.deepEqual(x.saida.commits, {109: commit}, rotulo);
      assert.match(x.saida.reconciliar, /--conferir-109/); assert.match(x.saida.reconciliar, /manter o cron suspenso/);
      const m = JSON.parse(fs.readFileSync(x.saida.marcador, 'utf8'));
      assert.equal(m.situacao, 'FALHA'); assert.equal(m.ambiente, 'production'); assert.deepEqual(m.commits, {109: commit}, rotulo + ' (marcador)');
      assert.equal(C.atual.retrato, R.RETRATO_075, rotulo + ': nada confirmado');
      await assert.rejects(prod.principal(APLICAR, ENV_PROD, {Client: clienteFalso(), dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('contrato TypeScript divergente do hash revisado na árvore implantada: FALHA sem ler nada do banco (conferência) e recusa antes de conectar (aplicação)', async () => {
  const outra = fs.mkdtempSync(path.join(os.tmpdir(), 'raiz-109-prod-'));
  try {
    for (const a of [...comum.ETAPAS.map(e => e[1]), ...comum.CONTRATO.map(e => e[0])]) {
      fs.mkdirSync(path.dirname(path.join(outra, a)), {recursive: true}); fs.copyFileSync(path.join(raiz, a), path.join(outra, a));
    }
    fs.appendFileSync(path.join(outra, comum.CONTRATO[0][0]), '\n// alterado\n');
    const C = clienteFalso();
    const x = await prod.principal(CONFERIR, ENV_PROD, {raiz: outra, Client: C});
    assert.equal(x.codigo, 2); assert.equal(x.saida.resultado, 'FALHA'); assert.match(x.saida.mensagem, /ARQUIVO_DIVERGENTE lib\/assinatura\/renovacao-schema\.ts/);
    assert.ok(!C.log.some(l => l.sql === comum.SQL_ESTADO), 'nada lido do banco');
    const N = nuncaConecta();
    await assert.rejects(prod.principal(APLICAR, ENV_PROD, {raiz: outra, Client: N, dir: path.join(outra, 'marcadores'), disco: semDisco}), /ARQUIVO_DIVERGENTE lib\/assinatura\/renovacao-schema\.ts/);
    assert.equal(N.construido, false); assert.equal(fs.existsSync(path.join(outra, 'marcadores')), false);
  } finally { fs.rmSync(outra, {recursive: true, force: true}); }
});

test('plano de produção sem conexão: alvo e registro de produção, ordem de produção (PITR de production, B-27: sem criar nem retomar cron); staging mantém a dele', async () => {
  const N = nuncaConecta();
  const {codigo, saida} = await prod.principal([], {}, {Client: N});
  assert.equal(codigo, 0); assert.equal(N.construido, false); assert.equal(saida.conecta, false); assert.equal(saida.ambiente, 'production');
  assert.deepEqual(saida.alvo, prod.ALVO); assert.equal(saida.registro, prod.DIR);
  assert.deepEqual(saida.ordem, [...prod.ORDEM]); assert.deepEqual(prod.plano().ordem, [...prod.ORDEM]);
  assert.ok(saida.ordem.findIndex(o => o.startsWith('--conferir-109: PRONTA_PARA_APLICAR')) < saida.ordem.indexOf('--aplicar-109-autorizado'));
  assert.ok(saida.ordem.some(o => /PostgreSQL de production/.test(o) && /PITR/.test(o)));
  assert.ok(saida.ordem.some(o => /autorização de Felipe para a 109 em production/.test(o)));
  assert.ok(saida.ordem.some(o => /imediatamente antes/.test(o)) && saida.ordem.some(o => /kidmais-renovacao\*/.test(o) && /ACCESS EXCLUSIVE/.test(o)));
  assert.ok(saida.ordem.some(o => /conjunto 075/.test(o) && /nunca valor novo a fixar/.test(o)));
  // B-27: a ordem de produção não manda reativar cron; termina dizendo que a 109 não cria nem retoma cron.
  assert.ok(!saida.ordem.some(o => /^reativar|voltar ao modo anterior|staging/.test(o)), 'nada da ordem de staging');
  assert.match(saida.ordem.at(-1), /^B-27 .*NÃO cria nem retoma cron de cobrança ou de renovação.*autorização própria de Felipe$/);
  const s = (await stg.principal([], {})).saida;
  for (const k of ['arquivos', 'provaNoAlvo', 'prazos', 'modos', 'preRequisitos', 'paradas', 'recuperacao', 'nuncaExecuta']) assert.deepEqual(saida[k], s[k], k);
  assert.ok(s.ordem.at(-1).startsWith('reativar o cron'), 'staging mantém a ordem dele');
  assert.ok(saida.nuncaExecuta.includes('down 109') && saida.nuncaExecuta.includes('suspender ou reativar o cron'));
  assert.deepEqual(prod.CODIGO, stg.CODIGO);
});
