/* eslint-disable @typescript-eslint/no-require-imports */
// Adaptadores de PRODUÇÃO da promoção de 12/11/2026 (112, 114, 116 e 117) e scripts/conexao-production.cjs, com cliente
// simulado: constantes iguais às do molde de produção (migration-100-production.cjs), trava de alvo e identidade de
// produção, rigidez herdada do par de staging (116/117), disco persistente, cruzamento com staging, conferência só leitura,
// aplicação pelo NÚCLEO (sem mudança) com marcador próprio de produção, situação do COMMIT, plano de produção, a chave da
// 117 e a prova só do núcleo na 114. Sem rede nem banco. O comportamento do núcleo é provado nas suítes de staging
// (scripts/migration-112.test.cjs, -114, -116, -117), que continuam valendo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {lerRevisado} = require('./migration-092-094-comum.cjs');
const prd = require('./conexao-production.cjs');
const molde = require('./migration-100-production.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_PROD = 'postgresql://usuario:SENHA_FALSA@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production';
const ENV_PROD = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'false', DATABASE_URL: URL_PROD});
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false',
  DATABASE_URL: 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'});
const ID_PROD = Object.freeze({db: 'kidmais_production', tls: true, tls_versao: 'TLSv1.3', servidor_privado: true});
const CONEXAO = Object.freeze({banco: 'kidmais_production', tls: true, tlsVersao: 'TLSv1.3', servidorPrivado: true});
const BACKUP = 'dump 2026-11-12T03:00Z sha 1234abcd PITR';
const erroPg = (code, msg = 'erro simulado') => Object.assign(new Error(msg), {code, severity: 'ERROR'});
const cheio = comum => Object.fromEntries(Object.entries(comum.OBJETOS).map(([k, v]) => [k, v.length]));
const vazio = comum => Object.fromEntries(Object.keys(comum.OBJETOS).map(k => [k, 0]));
const zeros = comum => Object.fromEntries(comum.PRESERVADAS.map(t => [t, 0]));

/**
 * Um caso por migration: o adaptador de produção, o de staging, o núcleo, o corpo que o núcleo envia como migration e as
 * respostas do banco simulado (as mesmas formas das suítes de staging). `criar()` devolve um respondedor com estado próprio:
 * recebe TODA consulta (inclusive ROLLBACK/COMMIT, para o estado dele) e devolve o resultado ou undefined.
 */
function caso112() {
  const comum = require('./migration-112-comum.cjs');
  const priv = {versao_pg: 180006, clientes: true, mesclagens: true, dono_clientes: true, dono_mesclagens: true, ler_clientes: true, usar_public: true, pode_criar: true, plpgsql: true, papel_trocado: true};
  return {id: '112', comum, prod: require('./migration-112-production.cjs'), stg: require('./migration-112-staging.cjs'), rigido: false, dir: 'clientes-pj-112-producao',
    corpo: comum.semCommitFinal(lerRevisado(raiz, comum.ETAPAS[1][1], comum.ETAPAS[1][2]), 'm'),
    criar: () => (sql, c) => {
      if (sql === comum.SQL_ESTADO) return {rows: [{...priv, ...(c.aplicada ? cheio(comum) : vazio(comum))}]};
      if (sql.startsWith('SELECT status::text')) return {rows: [{status: 'ATIVO', n: 4}]};
      if (sql.startsWith('SELECT tipo_pessoa')) return {rows: [{tipo: 'PF', n: 4}]};
      if (sql === comum.SQL_PRESERVACAO) return {rows: [{clientes_escritos: 0, mesclagens_escritas: 0}]};
    }};
}
function caso114() {
  const comum = require('./migration-114-comum.cjs');
  const base = aplicada => ({versao_pg: 180006, tabelas: 4, f114: aplicada,
    hash_lock: aplicada ? comum.CORPOS.depois.lock : comum.CORPOS.antes.lock, hash_revisao: aplicada ? comum.CORPOS.depois.revisao : comum.CORPOS.antes.revisao,
    hash_exigir: aplicada ? comum.HASH_EXIGIR : null, atributos_exigir: aplicada ? comum.ATRIBUTOS.exigir : null,
    atributos_lock: comum.ATRIBUTOS.lock, atributos_revisao: comum.ATRIBUTOS.revisao, contagem_ligada: true,
    gatilhos: comum.GATILHOS_ESPERADOS, dono_lock: true, dono_revisao: true, execute_publico: aplicada, ler_tabelas: true, usar_public: true, pode_criar: true, plpgsql: true, papel_trocado: true});
  const ZERO = comum.PRESERVADAS.map((tabela, i) => ({tabela, arquivo: String(1000 + i), escritas: 0}));
  return {id: '114', comum, prod: require('./migration-114-production.cjs'), stg: require('./migration-114-staging.cjs'), rigido: false, dir: 'agenda-114-producao',
    corpo: comum.semCommitFinal(lerRevisado(raiz, comum.ETAPAS[0][1], comum.ETAPAS[0][2]), 'm'),
    criar: () => {
      let travada = null, outraChave = false;
      return (sql, c) => {
        if (sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'ROLLBACK TO SAVEPOINT prova_114') { travada = null; outraChave = false; return undefined; }
        if (sql === comum.SQL_USAGE_PUBLIC) return {rows: [{usar_public: true}]};
        if (sql === comum.SQL_ESTADO) return {rows: [base(c.aplicada || c.pendente)]};
        if (sql === comum.SQL_PRESERVACAO) return {rows: ZERO};
        if (sql === comum.SQL_TRAVAR) { travada = c.params[0]; return {rows: []}; }
        if (sql === comum.SQL_TRAVAR_OUTRA_CHAVE) { outraChave = true; return {rows: []}; }
        if (sql === comum.SQL_EXIGIR) {
          // Só a trava da MESMA empresa (ou empresa nula) passa; sem trava, outra empresa ou outra chave = KD114.
          if (c.params[0] !== null && travada !== c.params[0]) { void outraChave; throw erroPg('KD114', 'sem trava'); }
          return {rows: []};
        }
      };
    }};
}
function caso116() {
  const comum = require('./migration-116-comum.cjs');
  const priv = {versao_pg: 180006, notificacoes: true, lotes: true, carteiras: true, contratacoes: true, dono_notificacoes: true,
    referencias_carteiras: true, referencias_lotes: true, referencias_contratacoes: true, ler_lotes: true, ler_notificacoes: true, ler_contratacoes: true, ler_carteiras: true,
    ler_franquias_ciclo: true, ler_pendencias: true, usar_public: true, pode_criar: true, plpgsql: true, papel_trocado: true};
  return {id: '116', comum, prod: require('./migration-116-production.cjs'), stg: require('./migration-116-staging.cjs'), rigido: true, dir: 'creditos-franquias-116-producao',
    corpo: comum.semCommitFinal(lerRevisado(raiz, comum.ETAPAS[1][1], comum.ETAPAS[1][2]), 'm'),
    criar: () => (sql, c) => {
      if (sql === comum.SQL_ESTADO) return {rows: [{...priv, ...(c.aplicada ? cheio(comum) : vazio(comum))}]};
      if (sql === comum.SQL_LOTES) return {rows: [{chave: 'COMPRA', n: 2}]};
      if (sql === comum.SQL_NOTIFICACOES) return {rows: [{chave: 'PAGAMENTO_CONFIRMADO', n: 2}]};
      if (sql === comum.SQL_NOVAS) return {rows: [{franquias_ciclo: 0, pendencias: 0, pendencias_abertas: 0}]};
      if (sql === comum.SQL_PRESERVACAO) return {rows: [zeros(comum)]};
    }};
}
function caso117() {
  const comum = require('./migration-117-comum.cjs');
  const priv = {versao_pg: 180006, empresas: true, mensagens: true, status: true, dono_mensagens: true, referencias_empresas: true,
    ler_empresas: true, ler_mensagens: true, ler_rodizio: true, ler_colisoes: true, usar_public: true, pode_criar: true, plpgsql: true, papel_trocado: true, indices_invalidos: []};
  return {id: '117', comum, prod: require('./migration-117-production.cjs'), stg: require('./migration-117-staging.cjs'), rigido: true, dir: 'whatsapp-multiempresa-117-producao',
    corpo: comum.semCommitFinal(lerRevisado(raiz, comum.ETAPAS[1][1], comum.ETAPAS[1][2]), 'm'),
    criar: () => (sql, c) => {
      if (sql === comum.SQL_USAGE_PUBLIC) return {rows: [{usar_public: true}]};
      if (sql === comum.SQL_ESTADO) return {rows: [{...priv, ...(c.aplicada ? cheio(comum) : vazio(comum))}]};
      if (sql === comum.SQL_MENSAGENS) return {rows: [{chave: 'production:ENTRADA', n: 7}]};
      if (sql === comum.SQL_NOVAS) return {rows: [{rodizio: 0, colisoes: 0}]};
      if (sql === comum.SQL_PRESERVACAO) return {rows: [zeros(comum)]};
      if (sql === comum.SQL_INDICES_INVALIDOS) return {rows: [{invalidos: []}]};
    }};
}
const CASOS = [caso112(), caso114(), caso116(), caso117()];

/** Cliente simulado transacional: o corpo da migration fica PENDENTE; 'COMMIT' confirma; 'ROLLBACK' descarta. */
function clienteFalso(caso, {aplicada = false, identidade = ID_PROD, falharCommit} = {}) {
  const log = []; let ro = false, pendente = false; const atual = {aplicada};
  const responder = caso.criar();
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql, params) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') ro = true;
      log.push({sql, ro, emTransacao: pendente});
      const r = responder(sql, {aplicada: atual.aplicada, pendente, params});
      if (r) return r;
      if (sql === 'ROLLBACK') { ro = false; pendente = false; return {rows: [], command: 'ROLLBACK'}; }
      if (sql === 'COMMIT') {
        if (falharCommit) throw falharCommit;
        if (pendente) atual.aplicada = true;
        pendente = false; return {rows: [], command: 'COMMIT'};
      }
      if (sql === prd.SQL_IDENTIDADE) return {rows: [identidade]};
      if (sql === caso.corpo) { assert.equal(ro, false, 'migration nunca em READ ONLY'); pendente = true; return {rows: []}; }
      return {rows: [], command: 'SET'};
    }
  };
  C.log = log; C.atual = atual;
  return C;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'promocao-prod-'));
const semDisco = () => {};
const flags = caso => ({conferir: [caso.comum.FLAG_CONFERIR], aplicar: [caso.comum.FLAG_APLICAR, '--backup', BACKUP]});

test('conexao-production: constantes iguais às do molde de produção (100) e lista PG* igual à dos adaptadores de staging', () => {
  assert.deepEqual(prd.ALVO, molde.ALVO);
  assert.equal(prd.SQL_IDENTIDADE, molde.SQL_IDENTIDADE);
  assert.equal(prd.DISCO, path.posix.dirname(molde.DIR));
  assert.deepEqual(prd.alvoMolde(ENV_PROD, 'kidmais-migration-100-production'), molde.alvo(ENV_PROD), 'configuração do cliente idêntica à do molde');
  assert.deepEqual(prd.identidade(ID_PROD), molde.identidade(ID_PROD));
  assert.deepEqual([...prd.PG_HERDADAS_RECUSADAS], [...require('./migration-117-staging.cjs').PG_HERDADAS_RECUSADAS]);
  assert.deepEqual([...prd.PG_HERDADAS_RECUSADAS], [...require('./migration-118-production.cjs').PG_HERDADAS_RECUSADAS]);
  assert.throws(() => prd.pastaRegistro('x-staging'), /REGISTRO_INVALIDO/);
  assert.throws(() => prd.pastaRegistro('../fora-producao'), /REGISTRO_INVALIDO/);
});

for (const caso of CASOS) {
  const {id, prod, stg, comum} = caso;
  const f = flags(caso);

  test(`${id}: trava de alvo de produção (serviço, ambiente, TLS obrigatório, host, banco, porta, URL sem query) e cruzamento com staging`, () => {
    const o = prod.alvo(ENV_PROD);
    assert.deepEqual(o.ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'});
    assert.equal(o.application_name, `kidmais-migration-${id}-production`);
    assert.equal(prod.alvo({...ENV_PROD, DATABASE_SSL_REJECT_UNAUTHORIZED: undefined}).ssl.rejectUnauthorized, true);
    for (const [delta, erro] of [[{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}, /SERVICO_RECUSADO/],
      [{KIDMAIS_DEPLOY_ENV: 'staging'}, /AMBIENTE_RECUSADO/], [{DATABASE_SSL: 'false'}, /TLS_OBRIGATORIO/], [{DATABASE_SSL: undefined}, /TLS_OBRIGATORIO/],
      [{DATABASE_URL: URL_PROD.replace('kidmais_production', 'kidmais_staging_1z91')}, /BANCO_RECUSADO/],
      [{DATABASE_URL: URL_PROD.replace('kidmais_production', 'kidmais_manager')}, /BANCO_RECUSADO/],
      [{DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'dpg-daidko3m8hqs73ce4jt0-a')}, /HOST_RECUSADO/],
      [{DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'dpg-dak750gae00c73fudmg0-a.virginia-postgres.render.com')}, /HOST_RECUSADO/],
      [{DATABASE_URL: URL_PROD.replace(':5432/', ':6543/')}, /PORTA_RECUSADA/], [{DATABASE_URL: URL_PROD + '?sslmode=disable'}, /CONNECTION_QUERY_REJECTED/],
      [{DATABASE_URL: 'nao-e-url'}, /URL_RECUSADA/]])
      assert.throws(() => prod.alvo({...ENV_PROD, ...delta}), erro, JSON.stringify(delta));
    // Mensagens só com o código: nunca URL, senha ou host.
    for (const delta of [{DATABASE_URL: URL_PROD + '?password=SEGREDO'}, {DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'host-SEGREDO')}]) {
      let msg = ''; try { prod.alvo({...ENV_PROD, ...delta}); } catch (e) { msg = String(e.message); }
      assert.match(msg, /^[A-Z_]+$/); assert.ok(!msg.includes('SEGREDO') && !msg.includes('SENHA_FALSA'));
    }
    assert.throws(() => stg.alvo(ENV_PROD), /SERVICO_RECUSADO/);
    assert.throws(() => prod.alvo(ENV_STG), /SERVICO_RECUSADO/);
    assert.deepEqual(prod.ALVO, molde.ALVO); assert.equal(prod.SQL_IDENTIDADE, molde.SQL_IDENTIDADE);
    assert.equal(prod.DIR, '/opt/render/project/src/data/' + caso.dir);
    assert.notEqual(prod.DIR, stg.DIR); assert.match(prod.DIR, /-producao$/);
  });

  test(`${id}: ${caso.rigido ? 'rigidez do par de staging mantida (PG* herdadas, ?/# vazios, controle, configuração explícita, senha fora da enumeração)' : 'configuração do cliente como a do molde e a do par de staging (connectionString)'}`, () => {
    const o = prod.alvo(ENV_PROD);
    if (!caso.rigido) {
      assert.equal(o.connectionString, URL_PROD); assert.ok(Object.hasOwn(stg.alvo(ENV_STG), 'connectionString'), 'o par de staging também usa connectionString');
      return;
    }
    assert.ok(!Object.hasOwn(o, 'connectionString') && !Object.hasOwn(stg.alvo(ENV_STG), 'connectionString'));
    assert.deepEqual({host: o.host, port: o.port, database: o.database, user: o.user}, {host: 'dpg-dak750gae00c73fudmg0-a', port: 5432, database: 'kidmais_production', user: 'usuario'});
    assert.equal(o.password, 'SENHA_FALSA'); assert.ok(!JSON.stringify(o).includes('SENHA_FALSA'), 'senha fora da enumeração');
    assert.deepEqual([...prod.PG_HERDADAS_RECUSADAS], [...stg.PG_HERDADAS_RECUSADAS]);
    for (const nome of stg.PG_HERDADAS_RECUSADAS) {
      assert.throws(() => prod.alvo({...ENV_PROD, [nome]: '-c search_path=outro'}), new RegExp('AMBIENTE_PG_RECUSADO ' + nome));
      assert.throws(() => stg.alvo({...ENV_STG, [nome]: '-c search_path=outro'}), new RegExp('AMBIENTE_PG_RECUSADO ' + nome), 'mesma recusa em staging');
    }
    for (const [delta, erro] of [[{DATABASE_URL: URL_PROD + '?'}, /CONNECTION_QUERY_REJECTED/], [{DATABASE_URL: URL_PROD + '#'}, /CONNECTION_QUERY_REJECTED/],
      [{DATABASE_URL: URL_PROD.replace('usuario', 'usuario%00options')}, /CREDENCIAL_COM_CONTROLE/], [{DATABASE_URL: URL_PROD.replace('SENHA_FALSA', 'SENHA%0AFALSA')}, /CREDENCIAL_COM_CONTROLE/],
      [{DATABASE_URL: URL_PROD.replace('usuario:SENHA_FALSA@', '')}, /CREDENCIAL_AUSENTE_NA_URL/], [{DATABASE_URL: URL_PROD.replace('postgresql:', 'https:')}, /URL_RECUSADA/],
      [{DATABASE_SSL_REJECT_UNAUTHORIZED: 'talvez'}, /TLS_CONFIGURACAO_RECUSADA/]])
      assert.throws(() => prod.alvo({...ENV_PROD, ...delta}), erro, JSON.stringify(delta));
  });

  test(`${id}: identidade provada pelo servidor (banco de produção, TLS 1.2/1.3, rede privada) e disco persistente`, () => {
    assert.deepEqual(prod.identidade(ID_PROD), CONEXAO);
    for (const [delta, erro] of [[{db: 'kidmais_staging_1z91'}, /BANCO_DIVERGENTE/], [{tls: false}, /SEM_TLS/], [{tls: null}, /SEM_TLS/],
      [{tls_versao: 'TLSv1.1'}, /TLS_VERSAO_RECUSADA/], [{servidor_privado: false}, /SERVIDOR_FORA_DA_REDE_PRIVADA/]])
      assert.throws(() => prod.identidade({...ID_PROD, ...delta}), erro);
    assert.throws(() => prod.identidade(undefined), /BANCO_DIVERGENTE/);
    assert.throws(() => prod.exigirDisco(path.join(os.tmpdir(), 'nao-existe-promocao-prod')), /DISCO_PERSISTENTE_AUSENTE/);
    const st = (dev, extra = {}) => ({dev, isDirectory: () => true, isSymbolicLink: () => false, ...extra});
    assert.doesNotThrow(() => prod.exigirDisco('/d/data', p => (p === '/d/data' ? st(2) : st(1))));
    assert.throws(() => prod.exigirDisco('/d/data', () => st(1)), /DISCO_PERSISTENTE_AUSENTE/, 'mesmo dispositivo do pai = disco efêmero');
    assert.throws(() => prod.exigirDisco('/d/data', p => (p === '/d/data' ? st(2, {isSymbolicLink: () => true}) : st(1))), /DISCO_PERSISTENTE_AUSENTE/);
  });

  test(`${id}: conferência de produção só leitura, nada no disco: ausente = PRONTA_PARA_APLICAR; presente = JA_APLICADA; identidade errada = FALHA`, async () => {
    const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
    fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
    try {
      const Pronta = clienteFalso(caso);
      const x = await prod.principal(f.conferir, ENV_PROD, {Client: Pronta});
      assert.equal(x.codigo, 0, JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'PRONTA_PARA_APLICAR');
      assert.deepEqual(x.saida.conexao, CONEXAO);
      assert.ok(Pronta.log.every(l => l.ro || l.sql === 'ROLLBACK'), 'tudo em READ ONLY');
      assert.ok(!Pronta.log.some(l => l.sql === caso.corpo || l.sql === 'COMMIT'));
      const Aplicada = clienteFalso(caso, {aplicada: true});
      const j = await prod.principal(f.conferir, ENV_PROD, {Client: Aplicada});
      assert.equal(j.codigo, 0, JSON.stringify(j.saida)); assert.equal(j.saida.resultado, 'JA_APLICADA_POSTCHECK_PASS');
      assert.ok(Aplicada.log.every(l => l.ro || l.sql === 'ROLLBACK'));
    } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
    assert.deepEqual(gravacoes, [], 'a conferência não grava arquivos');
    for (const identidade of [{...ID_PROD, db: 'kidmais_staging_1z91'}, {...ID_PROD, tls: false}, {...ID_PROD, servidor_privado: false}]) {
      const C = clienteFalso(caso, {identidade});
      const x = await prod.principal(f.conferir, ENV_PROD, {Client: C});
      assert.equal(x.codigo, 2); assert.equal(x.saida.resultado, 'FALHA'); assert.ok(!JSON.stringify(x).includes('SENHA_FALSA'));
      assert.ok(!C.log.some(l => l.sql === comum.SQL_ESTADO), 'estado não lido');
    }
    await assert.rejects(prod.principal(f.conferir, ENV_STG, {Client: clienteFalso(caso)}), /SERVICO_RECUSADO/);
  });

  test(`${id}: aplicação em produção pelo núcleo: backup obrigatório, disco antes de conectar, COMMIT confirmado, marcador de produção exclusivo`, async () => {
    await assert.rejects(prod.principal([comum.FLAG_APLICAR], ENV_PROD, {Client: clienteFalso(caso)}), /BACKUP_OBRIGATORIO/);
    let conectou = false;
    const Espia = class extends clienteFalso(caso) { async connect() { conectou = true; } };
    await assert.rejects(prod.executar({env: ENV_PROD, backup: BACKUP, dir: tmp(), Client: Espia}), /DISCO_PERSISTENTE_AUSENTE/);
    assert.equal(conectou, false, 'disco padrão do adaptador (ausente fora do Render) recusa antes de conectar');
    const dir = tmp();
    try {
      const C = clienteFalso(caso);
      const x = await prod.principal(f.aplicar, ENV_PROD, {Client: C, dir, disco: semDisco});
      assert.equal(x.codigo, 0, JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'APLICADA_POSTCHECK_PASS');
      assert.deepEqual(x.saida.commits, {[id]: 'CONFIRMADO'}); assert.deepEqual(x.saida.commitadas, [id]);
      const q = C.log.map(l => l.sql), iCorpo = q.indexOf(caso.corpo), iCommit = q.indexOf('COMMIT');
      assert.ok(iCorpo > 0 && iCommit > iCorpo, 'corpo sem o COMMIT do arquivo, depois o COMMIT do aplicador');
      assert.equal(q.filter(s => s === 'COMMIT').length, 1); assert.equal(q.filter(s => s === caso.corpo).length, 1);
      assert.ok(C.log.slice(0, iCorpo).every(l => l.ro || l.sql === 'ROLLBACK'), 'antes do corpo, tudo em READ ONLY');
      const m = JSON.parse(fs.readFileSync(x.saida.marcador, 'utf8'));
      assert.equal(path.basename(x.saida.marcador), comum.MARCADOR);
      assert.equal(m.ambiente, 'production'); assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.backup, BACKUP); assert.deepEqual(m.conexao, CONEXAO);
      assert.ok(!fs.readFileSync(x.saida.marcador, 'utf8').includes('SENHA_FALSA'));
      const n = C.log.length;
      await assert.rejects(prod.principal(f.aplicar, ENV_PROD, {Client: C, dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
      assert.equal(C.log.length, n, 'segunda tentativa não conecta');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    // Já aplicada: nenhum corpo enviado, nenhum COMMIT.
    const dir2 = tmp();
    try {
      const J = clienteFalso(caso, {aplicada: true});
      const x = await prod.principal(f.aplicar, ENV_PROD, {Client: J, dir: dir2, disco: semDisco});
      assert.equal(x.codigo, 0, JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'JA_APLICADA_POSTCHECK_PASS');
      assert.ok(!J.log.some(l => l.sql === caso.corpo || l.sql === 'COMMIT'));
    } finally { fs.rmSync(dir2, {recursive: true, force: true}); }
  });

  test(`${id}: falha NO COMMIT em produção: erro do servidor = DESFEITA; classe 57 ou sem resposta = INDETERMINADO; código 2, marcador FALHA`, async () => {
    for (const [erro, esperado] of [[erroPg('40P01'), 'DESFEITA_PELO_SERVIDOR'], [erroPg('57P01'), 'INDETERMINADO'], [erroPg('40003'), 'INDETERMINADO'],
      [new Error('Connection terminated unexpectedly'), 'INDETERMINADO']]) {
      const dir = tmp();
      try {
        const x = await prod.principal(f.aplicar, ENV_PROD, {Client: clienteFalso(caso, {falharCommit: erro}), dir, disco: semDisco});
        assert.equal(x.codigo, 2, JSON.stringify(x.saida)); assert.deepEqual(x.saida.commits, {[id]: esperado}); assert.deepEqual(x.saida.commitadas, []);
        assert.ok(x.saida.reconciliar.includes(comum.FLAG_CONFERIR));
        assert.equal(JSON.parse(fs.readFileSync(x.saida.marcador, 'utf8')).situacao, 'FALHA');
      } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    }
  });

  test(`${id}: plano de produção sem conexão: alvo e registro de produção, hashes do núcleo, ordem de produção; nunca o down`, async () => {
    const {codigo, saida} = await prod.principal([], {});
    assert.equal(codigo, 0); assert.equal(saida.conecta, false); assert.equal(saida.ambiente, 'production');
    assert.deepEqual(saida.alvo, prod.ALVO); assert.equal(saida.registro, prod.DIR);
    assert.deepEqual(saida.arquivos.map(a => a.sha256), comum.ETAPAS.map(e => e[2]));
    assert.deepEqual(saida.ordemProducao, [...prod.ORDEM]);
    assert.ok(saida.ordemProducao.indexOf(comum.FLAG_APLICAR) > saida.ordemProducao.findIndex(o => o.startsWith(comum.FLAG_CONFERIR)));
    assert.ok(saida.ordemProducao.some(o => /backup restaurável de production .*PITR/.test(o)) && saida.ordemProducao.includes(`autorização de Felipe para a ${id} em produção`));
    assert.ok(!saida.ordemProducao.some(o => /staging/.test(o)));
    assert.ok(saida.nuncaExecuta.includes(`down ${id}`) && !saida.arquivos.some(a => a.arquivo.includes('rollback')));
    // O adaptador de staging não ganha nada de produção.
    assert.equal((await stg.principal([], {})).saida.ordemProducao, undefined);
  });
}

test('117: o núcleo recusa aplicar com WHATSAPP_ATENDIMENTO_MULTIEMPRESA ligada ou inválida, ANTES do marcador e da conexão; a conferência informa e devolve RECUSARIA', async () => {
  const caso = CASOS.find(c => c.id === '117'), {prod} = caso, f = flags(caso);
  for (const [valor, estado] of [['true', 'LIGADA'], ['TRUE', 'INVALIDA'], ['1', 'INVALIDA'], ['', 'INVALIDA']]) {
    const env = {...ENV_PROD, WHATSAPP_ATENDIMENTO_MULTIEMPRESA: valor};
    const dir = tmp();
    try {
      const C = clienteFalso(caso);
      await assert.rejects(prod.principal(f.aplicar, env, {Client: C, dir, disco: semDisco}), new RegExp('CHAVE_MULTIEMPRESA_NAO_DESLIGADA ' + estado));
      assert.deepEqual(fs.readdirSync(dir), [], 'sem marcador'); assert.equal(C.log.length, 0, 'sem conexão');
      const K = clienteFalso(caso);
      const x = await prod.principal(f.conferir, env, {Client: K});
      assert.equal(x.codigo, 3, JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'RECUSARIA'); assert.equal(x.saida.chave, estado);
      assert.match(x.saida.motivo, new RegExp('CHAVE_MULTIEMPRESA_NAO_DESLIGADA ' + estado));
      assert.ok(!K.log.some(l => l.sql === caso.corpo || l.sql === 'COMMIT'));
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
  // Desligada (ausente ou "false"): aplica e a conferência informa DESLIGADA.
  for (const delta of [{}, {WHATSAPP_ATENDIMENTO_MULTIEMPRESA: 'false'}]) {
    const dir = tmp();
    try {
      const x = await prod.principal(f.aplicar, {...ENV_PROD, ...delta}, {Client: clienteFalso(caso), dir, disco: semDisco});
      assert.equal(x.codigo, 0, JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'APLICADA_POSTCHECK_PASS');
      assert.equal((await prod.principal(f.conferir, {...ENV_PROD, ...delta}, {Client: clienteFalso(caso)})).saida.chave, 'DESLIGADA');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
  assert.ok((await prod.principal([], {})).saida.nuncaExecuta.includes('ligar WHATSAPP_ATENDIMENTO_MULTIEMPRESA'));
  assert.ok(prod.ORDEM.some(o => /WHATSAPP_ATENDIMENTO_MULTIEMPRESA DESLIGADA/.test(o)));
});

test('114: sem checks externos — só a migration tem arquivo; a prova é do núcleo (estado por hash, preservação e prova funcional KD114 na transação e depois em READ ONLY)', async () => {
  const caso = CASOS.find(c => c.id === '114'), {prod, comum} = caso, f = flags(caso);
  assert.deepEqual(comum.ETAPAS.map(e => e[0]), ['migration 114']);
  const p = (await prod.principal([], {})).saida;
  assert.deepEqual(p.arquivos.map(a => a.arquivo), ['database/migrations/20261031_114_trava_configuracao_gatilhos.sql']);
  assert.ok(!fs.existsSync(path.join(raiz, 'database/checks/20261031_114_precheck.sql')) && !fs.existsSync(path.join(raiz, 'database/checks/20261031_114_postcheck.sql')));
  // Os 2 itens do plano do núcleo que citam staging saem trocados pelos de produção; o resto do plano é o do núcleo.
  assert.ok(!p.preRequisitos.some(x => /staging/.test(x)) && p.preRequisitos.includes(prod.PRE_REQUISITO_PRODUCAO));
  assert.ok(!p.ordem.some(x => /staging/.test(x)) && p.ordem.includes(prod.CONFERENCIA_PRODUCAO));
  const s = (await caso.stg.principal([], {})).saida;
  assert.equal(p.preRequisitos.length, s.preRequisitos.length); assert.equal(p.ordem.length, s.ordem.length);
  assert.deepEqual(p.preRequisitos.slice(0, -1), s.preRequisitos.slice(0, -1));
  const dir = tmp();
  try {
    const C = clienteFalso(caso);
    const x = await prod.principal(f.aplicar, ENV_PROD, {Client: C, dir, disco: semDisco});
    assert.equal(x.codigo, 0, JSON.stringify(x.saida)); assert.equal(x.saida.provaFuncionalDepois, 'PASS');
    const q = C.log.map(l => l.sql), entre = q.slice(q.indexOf(caso.corpo) + 1, q.indexOf('COMMIT'));
    assert.ok(entre.includes(comum.SQL_ESTADO) && entre.includes(comum.SQL_PRESERVACAO) && entre.includes(comum.SQL_EXIGIR), 'provas dentro da transação');
    assert.ok(C.log.slice(q.indexOf('COMMIT') + 1).filter(l => l.sql === comum.SQL_EXIGIR).every(l => l.ro), 'prova depois em READ ONLY');
    assert.deepEqual(JSON.parse(fs.readFileSync(x.saida.marcador, 'utf8')).etapas[0].antesDoCommit, {estado: 'PASS', preservacao: 'PASS', provaFuncional: 'PASS'});
    // Nenhum SQL de check externo foi enviado: tudo o que não é do núcleo é moldura de transação.
    const doNucleo = new Set([caso.corpo, comum.SQL_ESTADO, comum.SQL_PRESERVACAO, comum.SQL_USAGE_PUBLIC, comum.SQL_EXIGIR, comum.SQL_TRAVAR, comum.SQL_TRAVAR_OUTRA_CHAVE, prd.SQL_IDENTIDADE]);
    assert.deepEqual(q.filter(sql => !doNucleo.has(sql) && !/^(BEGIN TRANSACTION READ ONLY|ROLLBACK|COMMIT|SET LOCAL |SAVEPOINT |RELEASE SAVEPOINT |ROLLBACK TO SAVEPOINT )/.test(sql)), []);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
