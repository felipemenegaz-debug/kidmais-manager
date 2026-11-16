/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 107/108 de PRODUÇÃO com cliente simulado (o mesmo desenho da suíte de staging: só CONFIRMA no COMMIT e
// descarta no ROLLBACK). Aqui os esperados do retrato são os do ARQUIVO VERSIONADO (o adaptador de produção, como o de
// staging, recusa os injetados): trava de alvo e identidade de produção, disco, cruzamento com staging, variável faltando
// recusa ANTES de conectar, override de retratos de teste recusado em todos os modos, variantes aprovadas passando do jeito
// que o núcleo espera (F0 canônico/deriva/staging_20261030, F1, F2), retrato de produção FORA das variantes recusa com o
// hash medido, estados 107 × 108 (ausente, completa, parcial, 098 histórica), sha dos arquivos, aplicação com marcadores de
// produção e a ordem de produção no plano. O núcleo (scripts/migration-107-108-comum.cjs) é o de staging, intacto.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const comum = require('./migration-107-108-comum.cjs');
const prod = require('./migration-107-108-production.cjs');
const stg = require('./migration-107-108-staging.cjs');
const def107 = require('./migration-107-definicoes.cjs');
const ret108 = require('./migration-108-retrato.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_PROD = 'postgresql://usuario:SENHA_FALSA@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production';
const ENV_PROD = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'false', DATABASE_URL: URL_PROD});
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false',
  DATABASE_URL: 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'});
const ID_PROD = {db: 'kidmais_production', tls: true, tls_versao: 'TLSv1.3', servidor_privado: true};
const CONEXAO = {banco: 'kidmais_production', tls: true, tlsVersao: 'TLSv1.3', servidorPrivado: true};
const BACKUP = 'PITR 2026-11-12T03:00Z production ref-1';
const DRENAGEM = 'web manutencao 03:05Z cron suspenso';
const CONFERIR = [comum.FLAG_CONFERIR], APLICAR = [comum.FLAG_APLICAR, comum.FLAG_BACKUP, BACKUP, comum.FLAG_DRENAGEM, DRENAGEM];
/** Os esperados REAIS (arquivo fixado por hash): é com eles que o adaptador de produção trabalha. */
const ESP = ret108.carregarEsperados(raiz);
const FORA = 'e'.repeat(64);
const ler = nome => { const [, a, h] = comum.ARQUIVOS.find(e => e[0] === nome); return comum.lerRevisado(raiz, a, h); };
const M107 = ler('migration 107'), M108 = ler('migration 108');
const C107 = comum.semMoldura(M107, 'm107'), C108 = comum.semMoldura(M108, 'm108');
const AV = def107.sqlAvaliacao107(), IN = def107.sqlIntegridade107(), RT = ret108.sqlRetrato108({raiz});
const PV = ret108.sqlProva108Integra({esperados: ESP, raiz});
const ARQ = Object.fromEntries(comum.ARQUIVOS.map(([n]) => [n, ler(n)]));
const erroPg = (code, msg = 'erro simulado') => Object.assign(new Error(msg), {code});
const semDisco = () => {};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-107-108-prod-'));

const PRIVILEGIOS = ['usar_public', 'pode_criar', 'temp', 'plpgsql', 'linguagem_sql', ...comum.TABELAS_LEITURA.map(t => 'ler_' + t), 'ler_reparos', 'executar_ocupacoes',
  'dono_bloqueios', 'dono_config_agenda', 'gatilho_bloqueios', 'gatilho_config_agenda', 'travar_bloqueios', 'travar_config_agenda', 'executar_set_atualizado', 'dono_saloes',
  'dono_contratos', 'dono_funcoes_108', 'gatilho_saloes', 'gatilho_contratos', 'travar_saloes', 'travar_contratos', 'ver_atividade'];
const CORPO_100 = '805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb';
const CONTRATO_094 = '4d462947bc173967fe9ff059a4aa857bd068502c042ae81a97c918e3362bf43e';
const REVISAO_094 = '951825ad597495b477963ebb74df0120c1e8f4c59d39f6b7b32f53e5baaea821';
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
 * Cliente simulado transacional (como na suíte de staging). `variante` = a variante do arquivo de esperados que o banco
 * "tem" em cada fase (canonico | deriva_conhecida | staging_20261030); `retratoFora` = um hash que não é nenhuma variante
 * (production ainda não medida). A avaliação da 107 acompanha: tudo CANONICO só na variante canônica.
 */
function clienteFalso(opcoes = {}) {
  const {m107 = 'ausente', m108 = 'AUSENTE', variante = 'canonico', avaliacaoCanonica = ['canonico', 'production_20261112'].includes(variante), retratoFora = false, extra = {}, avaria108 = false, falharEm, erro, falharCommit,
    atividade = SEM_ATIVIDADE, identidade = ID_PROD} = opcoes;
  const log = []; let ro = false, tx = false, caminho = null, pendente = null, commits = 0;
  const atual = {m107, m108};
  const visao = () => (pendente ? {...atual, ...pendente} : atual);
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') ro = true;
      if (sql === 'BEGIN') { tx = true; }
      const m = /^SET LOCAL search_path = (.*)$/.exec(sql); if (m) caminho = m[1];
      log.push({sql, ro, tx, caminho});
      if (falharEm && sql.includes(falharEm)) throw erro ?? erroPg('P0001', 'falha simulada em ' + falharEm);
      if (sql === 'ROLLBACK') { ro = false; tx = false; pendente = null; caminho = null; return {rows: [], command: 'ROLLBACK'}; }
      if (sql === 'COMMIT') {
        commits++; tx = false; caminho = null;
        if (falharCommit && falharCommit.n === commits) { pendente = null; throw falharCommit.erro; }
        if (pendente) Object.assign(atual, pendente);
        pendente = null;
        return {rows: [], command: 'COMMIT'};
      }
      if (sql.startsWith('SET LOCAL ') || sql === 'BEGIN' || sql === 'BEGIN TRANSACTION READ ONLY') return {rows: []};
      const v = visao();
      if (sql === prod.SQL_IDENTIDADE) return {rows: [identidade]};
      if (sql === comum.SQL_ESTADO) return {rows: [estadoLinha(v, extra)]};
      if (sql === comum.SQL_ATIVIDADE) return {rows: [{...atividade}]};
      if (sql === comum.SQL_SESSOES) return {rows: [{...SESSOES}]};
      if (sql === AV) {
        return {rows: def107.DEFINICOES.map(d => ({n: d.n, canonico: d.canonico, ja_aplicada: v.m107 !== 'ausente', pg_maior: 18,
          estado: avaliacaoCanonica ? 'CANONICO' : d.tipo === 'N' || d.tipo === 'T' ? 'AUSENTE_CRIAVEL' : 'DERIVA'}))};
      }
      if (sql === IN) {
        return {rows: v.m107 === 'aplicada' ? [{ok: true, motivo: 'pg'}, {ok: true, motivo: 'base'}] : [{ok: true, motivo: 'pg'}, {ok: false, motivo: 'registro kidmais107_reparos ausente'}]};
      }
      if (sql === RT) {
        const fase = v.m107 === 'ausente' ? 'F0' : v.m108 === 'AUSENTE' ? 'F1' : 'F2';
        // F1 e F2 não têm a variante deriva_conhecida (a 107 já reparou): o banco da deriva fica canônico depois da 107.
        const h = retratoFora ? FORA : ESP[fase][variante] ?? ESP[fase].canonico;
        return {rows: [{hash_108: h, retrato_108: {funcoes: [['x()', 'h']], marcador_108: null}, search_path: caminho, versao_pg: 180006}]};
      }
      if (sql === PV) {
        const integra = v.m107 === 'aplicada' && v.m108 === 'NOVA' && !avaria108;
        return {rows: [{integra, motivos: integra ? [] : ['MARCADOR_108', 'RETRATO_F2']}]};
      }
      if (sql === ARQ['precheck 107'] && v.m107 !== 'ausente') throw erroPg('P0001', '107 precheck: agenda da 005 ausente ou 107 já aplicada');
      if (sql === ARQ['precheck 108 pre-107'] && v.m108 !== 'AUSENTE') throw erroPg('P0001', '108: precheck falhou');
      if (sql === ARQ['precheck 108'] && (v.m107 !== 'aplicada' || v.m108 !== 'AUSENTE')) throw erroPg('P0001', '108: precheck falhou (107 ausentes)');
      if (sql === ARQ['integridade 107'] && v.m107 !== 'aplicada') throw erroPg('P0001', '107 integridade: registro ausente');
      if (sql === ARQ['postcheck 108'] && v.m108 !== 'NOVA') throw erroPg('P0001', '108 postcheck: instalação incompleta');
      if (sql === comum.SQL_EXECUCAO_108) return {rows: [{executa_108: true}]};
      if (sql === C107) { assert.ok(tx && !ro, 'corpo só em transação de escrita'); pendente = {id: '107', m107: 'aplicada'}; }
      if (sql === C108) { assert.ok(tx && !ro, 'corpo só em transação de escrita'); pendente = {id: '108', m108: 'NOVA'}; }
      assert.ok(sql !== M107 && sql !== M108, 'o arquivo COM a moldura nunca é enviado');
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
const escritas = log => log.filter(x => !x.ro && (x.sql === C107 || x.sql === C108 || x.sql.startsWith('LOCK TABLE')));
const corpos = log => log.filter(x => x.sql === C107 || x.sql === C108).map(x => (x.sql === C107 ? '107' : '108'));
const ALVOS_ERRADOS = [[{RENDER: undefined}, /^FORA_DO_RENDER$/], [{RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}, /^SERVICO_RECUSADO$/], [{RENDER_SERVICE_ID: undefined}, /^SERVICO_RECUSADO$/],
  [{KIDMAIS_DEPLOY_ENV: 'staging'}, /^AMBIENTE_RECUSADO$/], [{KIDMAIS_DEPLOY_ENV: undefined}, /^AMBIENTE_RECUSADO$/],
  [{DATABASE_SSL: 'false'}, /^TLS_OBRIGATORIO$/], [{DATABASE_SSL: undefined}, /^TLS_OBRIGATORIO$/],
  [{DATABASE_URL: undefined}, /^URL_RECUSADA$/], [{DATABASE_URL: 'nao-e-url'}, /^URL_RECUSADA$/],
  [{DATABASE_URL: URL_PROD.replace('kidmais_production', 'kidmais_staging_1z91')}, /^BANCO_RECUSADO$/],
  [{DATABASE_URL: URL_PROD.replace('kidmais_production', 'kidmais_manager')}, /^BANCO_RECUSADO$/],
  [{DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'dpg-daidko3m8hqs73ce4jt0-a')}, /^HOST_RECUSADO$/],
  [{DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'dpg-dak750gae00c73fudmg0-a.virginia-postgres.render.com')}, /^HOST_RECUSADO$/],
  [{DATABASE_URL: URL_PROD.replace(':5432/', ':6543/')}, /^PORTA_RECUSADA$/], [{DATABASE_URL: URL_PROD + '?sslmode=disable'}, /^CONNECTION_QUERY_REJECTED$/]];

test('sha dos arquivos e dos downs fixados no núcleo conferem com a árvore; o plano de produção lista os mesmos e as variantes do arquivo de esperados', async () => {
  for (const [, arquivo, hash] of [...comum.ARQUIVOS, ...comum.RECUPERACAO]) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), hash, arquivo);
  }
  const {saida} = await prod.principal([], {});
  assert.deepEqual(saida.arquivos.map(a => [a.arquivo, a.sha256]), comum.ARQUIVOS.map(e => [e[1], e[2]]));
  assert.deepEqual(saida.recuperacaoArquivos.map(a => [a.nome, a.sha256]), comum.RECUPERACAO.map(e => [e[0], e[2]]));
  // As variantes aceitas em produção são exatamente as do arquivo versionado (o adaptador não acrescenta nenhuma).
  assert.deepEqual(saida.retratos, Object.fromEntries(ret108.FASES.map(f => [f, Object.keys(ESP[f])])));
  assert.deepEqual(saida.retratos, (await stg.principal([], {})).saida.retratos, 'as mesmas de staging');
  // A única variante de production é a MEDIDA na janela de 12/11/2026 e reproduzida na suíte PostgreSQL (VARIANTE_PRODUCTION).
  assert.deepEqual(Object.values(saida.retratos).flat().filter(v => /prod/i.test(v)), ['production_20261112', 'production_20261112', 'production_20261112'], 'nenhuma variante de produção inventada');
});

test('trava de alvo de produção: serviço, ambiente, TLS obrigatório (certificado conforme o serviço), host, banco, porta, URL sem query', () => {
  const o = prod.alvo(ENV_PROD);
  assert.deepEqual(o.ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'});
  assert.equal(o.application_name, 'kidmais-migration-107-108-production'); assert.equal(o.connectionString, URL_PROD);
  assert.equal(prod.alvo({...ENV_PROD, DATABASE_SSL_REJECT_UNAUTHORIZED: undefined}).ssl.rejectUnauthorized, true);
  for (const [delta, erro] of ALVOS_ERRADOS) assert.throws(() => prod.alvo({...ENV_PROD, ...delta}), e => erro.test(e.message), JSON.stringify(delta));
  for (const delta of [{DATABASE_URL: URL_PROD + '?password=SEGREDO'}, {DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'host-SEGREDO')}]) {
    let msg = ''; try { prod.alvo({...ENV_PROD, ...delta}); } catch (e) { msg = String(e.message); }
    assert.match(msg, /^[A-Z_]+$/); assert.ok(!msg.includes('SEGREDO') && !msg.includes('SENHA_FALSA'));
  }
  assert.throws(() => stg.alvo(ENV_PROD), /SERVICO_RECUSADO/);
  assert.throws(() => prod.alvo(ENV_STG), /SERVICO_RECUSADO/);
  assert.deepEqual(prod.ALVO, {servico: 'srv-dak77m2d0e5s73b8rkkg', host: 'dpg-dak750gae00c73fudmg0-a', database: 'kidmais_production', port: 5432});
  assert.equal(prod.DIR, '/opt/render/project/src/data/saloes-107-108-producao'); assert.notEqual(prod.DIR, stg.DIR);
});

test('alvo errado ou variável faltando: CONFERIR e APLICAR recusam (lançam, código 1 na CLI) ANTES de construir o cliente e de tocar o disco', async () => {
  for (const [delta, erro] of ALVOS_ERRADOS) {
    const env = {...ENV_PROD, ...delta};
    for (const argv of [CONFERIR, APLICAR]) {
      const N = nuncaConecta(); const dir = path.join(os.tmpdir(), 'nao-criado-107-108-prod');
      await assert.rejects(prod.principal(argv, env, {Client: N, dir, disco: () => assert.fail('DISCO_CONSULTADO')}), e => erro.test(e.message), JSON.stringify(delta) + argv[0]);
      assert.equal(N.construido, false, 'cliente não construído'); assert.equal(fs.existsSync(dir), false, 'nada no disco');
    }
  }
  await assert.rejects(prod.principal(CONFERIR, ENV_STG, {Client: nuncaConecta()}), /SERVICO_RECUSADO/);
  await assert.rejects(prod.principal([comum.FLAG_APLICAR], ENV_PROD, {Client: nuncaConecta()}), /BACKUP_OBRIGATORIO/);
  await assert.rejects(prod.principal([comum.FLAG_APLICAR, comum.FLAG_BACKUP, BACKUP], ENV_PROD, {Client: nuncaConecta()}), /DRENAGEM_OBRIGATORIA/);
  await assert.rejects(prod.principal([comum.FLAG_APLICAR, comum.FLAG_BACKUP, 'x;rm', comum.FLAG_DRENAGEM, DRENAGEM], ENV_PROD, {Client: nuncaConecta()}), /BACKUP_INVALIDO/);
  await assert.rejects(prod.principal(['--conferir-104-106'], ENV_PROD, {Client: nuncaConecta()}), /ARGUMENTOS_RECUSADOS/);
});

test('override de retratos de teste (KIDMAIS_RETRATOS_108_TESTE): recusado em produção no PLANO, no CONFERIR e no APLICAR, válido ou ilegível, antes de conectar', async () => {
  const valido = JSON.stringify({...ESP, F0: {...ESP.F0, production_inventada: FORA}});
  for (const valor of [valido, '{', '']) {
    const env = {...ENV_PROD, [comum.ENV_RETRATOS_TESTE]: valor};
    for (const argv of [[], CONFERIR, APLICAR]) {
      const N = nuncaConecta(); const dir = path.join(os.tmpdir(), 'nao-criado-107-108-prod-retratos');
      await assert.rejects(prod.principal(argv, env, {Client: N, dir, disco: semDisco}), /RETRATOS_DE_TESTE_RECUSADOS/, JSON.stringify(argv));
      assert.equal(N.construido, false); assert.equal(fs.existsSync(dir), false);
    }
  }
});

test('identidade provada pelo servidor: banco de produção, TLS ativo 1.2/1.3 e servidor em rede privada; disco persistente', async () => {
  assert.deepEqual(prod.identidade(ID_PROD), CONEXAO);
  assert.equal(prod.identidade({...ID_PROD, tls_versao: 'TLSv1.2'}).tlsVersao, 'TLSv1.2');
  for (const [delta, erro] of [[{db: 'kidmais_staging_1z91'}, /BANCO_DIVERGENTE/], [{tls: false}, /SEM_TLS/], [{tls: null}, /SEM_TLS/],
    [{tls_versao: 'TLSv1.1'}, /TLS_VERSAO_RECUSADA/], [{servidor_privado: false}, /SERVIDOR_FORA_DA_REDE_PRIVADA/]])
    assert.throws(() => prod.identidade({...ID_PROD, ...delta}), erro);
  assert.throws(() => prod.identidade(undefined), /BANCO_DIVERGENTE/);
  assert.match(prod.SQL_IDENTIDADE, /pg_stat_ssl/); assert.match(prod.SQL_IDENTIDADE, /inet_server_addr\(\)/);
  assert.throws(() => prod.exigirDisco(path.join(os.tmpdir(), 'nao-existe-107-108-prod')), /DISCO_PERSISTENTE_AUSENTE/);
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

test('variantes aprovadas passam pelo adaptador como o núcleo espera: F0 canônico/deriva/staging_20261030/production_20261112, F1 e F2; CONFERIR só lê e nada grava', async () => {
  const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
  fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
  try {
    for (const [m, fase, resultado, retrato] of [
      [{variante: 'canonico'}, 'F0', 'PRONTA_PARA_APLICAR', 'canonico'], [{variante: 'deriva_conhecida'}, 'F0', 'PRONTA_PARA_APLICAR', 'deriva_conhecida'],
      [{variante: 'staging_20261030'}, 'F0', 'PRONTA_PARA_APLICAR', 'staging_20261030'],
      [{variante: 'production_20261112'}, 'F0', 'PRONTA_PARA_APLICAR', 'production_20261112'],
      [{m107: 'aplicada', variante: 'production_20261112'}, 'F1', 'PRONTA_PARA_APLICAR', 'production_20261112'],
      [{m107: 'aplicada', variante: 'canonico'}, 'F1', 'PRONTA_PARA_APLICAR', 'canonico'], [{m107: 'aplicada', variante: 'staging_20261030'}, 'F1', 'PRONTA_PARA_APLICAR', 'staging_20261030'],
      [{m107: 'aplicada', m108: 'NOVA'}, 'F2', 'JA_APLICADA_INTEGRIDADE_PASS', null]]) {
      const C = clienteFalso(m);
      const x = await prod.principal(CONFERIR, ENV_PROD, {Client: C});
      assert.equal(x.codigo, 0, JSON.stringify(x.saida)); assert.equal(x.saida.resultado, resultado); assert.equal(x.saida.fase, fase);
      assert.deepEqual(x.saida.conexao, CONEXAO);
      if (retrato) { assert.equal(x.saida.verificacoes['retrato ' + fase], retrato); assert.equal(x.saida.retrato.hash, ESP[fase][retrato]); }
      else assert.deepEqual(x.saida.verificacoes, {'integridade 107': 'PASS', 'prova 108': 'PASS'});
      assert.deepEqual(escritas(C.log), []);
      assert.ok(!C.log.some(l => l.sql === 'BEGIN' || l.sql === 'COMMIT' || l.sql.startsWith('LOCK')), 'sem transação de escrita');
      const controle = /^(BEGIN TRANSACTION READ ONLY|ROLLBACK|SET LOCAL )/;
      assert.ok(C.log.filter(l => !controle.test(l.sql)).every(l => l.ro), 'toda consulta dentro de READ ONLY');
      for (const sql of [AV, IN, RT, PV]) assert.ok(C.log.filter(l => l.sql === sql).every(l => l.caminho === 'pg_catalog'), 'construtores com search_path pg_catalog');
    }
  } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
  assert.deepEqual(gravacoes, [], 'a conferência não grava arquivos');
});

test('retrato de production FORA das variantes aprovadas: CONFERIR mede, mostra o hash e recusa (código 3); APLICAR falha antes de qualquer escrita', async () => {
  for (const [m, fase] of [[{}, 'F0'], [{m107: 'aplicada'}, 'F1']]) {
    const C = clienteFalso({...m, retratoFora: true});
    const x = await prod.principal(CONFERIR, ENV_PROD, {Client: C});
    assert.equal(x.codigo, 3, JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'RECUSARIA');
    assert.match(x.saida.motivo, new RegExp('^RETRATO_' + fase + '_DIVERGENTE ' + FORA));
    assert.equal(x.saida.retrato.hash, FORA, 'o hash medido sai para o registro (nunca vira referência)');
    assert.deepEqual(Object.keys(x.saida.retrato.secoes), ['funcoes', 'marcador_108']); assert.equal(x.saida.retrato.variante, undefined);
    assert.deepEqual(escritas(C.log), []);
    const dir = tmp();
    try {
      const A = clienteFalso({...m, retratoFora: true});
      const a = await prod.principal(APLICAR, ENV_PROD, {Client: A, dir, disco: semDisco});
      assert.equal(a.codigo, 2); assert.match(a.saida.falha.mensagem, new RegExp('RETRATO_' + fase + '_DIVERGENTE')); assert.deepEqual(a.saida.commits, {});
      assert.deepEqual(escritas(A.log), [], 'nenhum LOCK nem corpo'); assert.deepEqual(A.atual, {m107: m.m107 ?? 'ausente', m108: 'AUSENTE'});
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('produção recusa (CONFERIR 3, APLICAR 2, nada escrito): 108 parcial, 098 histórica, 108 sem a 107, PostgreSQL fora do 18, dependência, privilégio, atividade, prova da 108 e F0 incoerente', async () => {
  for (const [opcoes, motivo] of [[{m107: 'aplicada', m108: 'PARCIAL'}, /APLICACAO_PARCIAL_108/], [{m108: 'PARCIAL'}, /APLICACAO_PARCIAL_108/],
    [{m107: 'aplicada', m108: 'ANTIGA'}, /COM_098_HISTORICA/], [{m108: 'NOVA'}, /NOVA_SEM_107/],
    [{extra: {versao_pg: 170005}}, /PG_MAIOR_DIFERENTE 170005/], [{extra: {d108: false}}, /SEM_DEPENDENCIA_108/], [{extra: {base107: false}}, /SEM_BASE_107/],
    [{extra: {dono_saloes: false}}, /SEM_PRIVILEGIO_108 DONO_AGENDA_SALOES/], [{extra: {ver_atividade: false}}, /ATIVIDADE_NAO_VERIFICAVEL/],
    [{atividade: {...SEM_ATIVIDADE, locks: 1, sessoes: 1, sessoes_em_transacao: 1}}, /ATIVIDADE_NAS_TABELAS 1 sessão/],
    [{m107: 'aplicada', m108: 'NOVA', avaria108: true}, /INTEGRIDADE_108 MARCADOR_108 RETRATO_F2/],
    // Coerência do F0: production_20261112 conta como canônica (só com a 107 toda CANONICO); a deriva nunca com tudo CANONICO.
    [{variante: 'production_20261112', avaliacaoCanonica: false}, /RETRATO_F0_INCOERENTE variante production_20261112/],
    [{variante: 'deriva_conhecida', avaliacaoCanonica: true}, /RETRATO_F0_INCOERENTE variante deriva_conhecida/]]) {
    const C = clienteFalso(opcoes);
    const x = await prod.principal(CONFERIR, ENV_PROD, {Client: C});
    assert.equal(x.codigo, 3, String(motivo) + JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'RECUSARIA'); assert.match(x.saida.motivo, motivo);
    assert.deepEqual(escritas(C.log), []);
    const dir = tmp();
    try {
      const A = clienteFalso(opcoes);
      const a = await prod.principal(APLICAR, ENV_PROD, {Client: A, dir, disco: semDisco});
      assert.equal(a.codigo, 2, String(motivo)); assert.match(a.saida.falha.mensagem, motivo); assert.deepEqual(a.saida.commits, {});
      assert.deepEqual(escritas(A.log), [], 'recusa sem LOCK nem corpo');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('aplicação em produção: disco exigido antes de conectar, duas transações com LOCK na ordem fixa, marcadores de produção (execução e por etapa)', async () => {
  const N = nuncaConecta();
  await assert.rejects(prod.executar({env: ENV_PROD, backup: BACKUP, drenagem: DRENAGEM, dir: tmp(), Client: N}), /DISCO_PERSISTENTE_AUSENTE/);
  assert.equal(N.construido, false, 'disco padrão do adaptador (ausente fora do Render) recusa antes de conectar');
  for (const variante of ['canonico', 'deriva_conhecida', 'staging_20261030']) {
    const dir = tmp();
    try {
      const C = clienteFalso({variante});
      const x = await prod.principal(APLICAR, ENV_PROD, {Client: C, dir, disco: semDisco});
      assert.equal(x.codigo, 0, variante + JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'APLICADA_POSTCHECK_PASS');
      assert.deepEqual(x.saida.etapas, ['transacao 107', 'transacao 108']); assert.deepEqual(x.saida.commits, {107: 'CONFIRMADO', 108: 'CONFIRMADO'});
      assert.deepEqual(corpos(C.log), ['107', '108']);
      assert.deepEqual(escritas(C.log).map(l => l.sql), [comum.SQL_LOCK['107'], C107, comum.SQL_LOCK['108'], C108], 'LOCK antes de cada corpo, 107 antes da 108');
      const m = JSON.parse(fs.readFileSync(x.saida.marcador, 'utf8'));
      assert.equal(path.basename(x.saida.marcador), 'migration-107-108.json');
      assert.equal(m.ambiente, 'production'); assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.backup, BACKUP); assert.equal(m.drenagem, DRENAGEM);
      assert.deepEqual(m.conexao, CONEXAO); assert.equal(m.etapas[0].revalidacao['retrato F0'], variante);
      for (const id of ['107', '108']) assert.equal(JSON.parse(fs.readFileSync(path.join(dir, comum.marcadorEtapa(id)), 'utf8')).situacao, 'CONFIRMADO', 'marcador da etapa ' + id);
      assert.ok(!fs.readFileSync(x.saida.marcador, 'utf8').includes('SENHA_FALSA'));
      await assert.rejects(prod.principal(APLICAR, ENV_PROD, {Client: clienteFalso(), dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
  // Só a 108 pendente (107 aplicada) e tudo aplicado.
  for (const [m, etapas, resultado] of [[{m107: 'aplicada'}, ['transacao 108'], 'APLICADA_POSTCHECK_PASS'], [{m107: 'aplicada', m108: 'NOVA'}, [], 'JA_APLICADA_INTEGRIDADE_PASS']]) {
    const dir = tmp();
    try {
      const C = clienteFalso(m);
      const r = await prod.executar({env: ENV_PROD, backup: BACKUP, drenagem: DRENAGEM, dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, resultado, JSON.stringify(r)); assert.deepEqual(r.etapas, etapas); assert.deepEqual(corpos(C.log), etapas.map(e => e.slice(-3)));
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('falhas na aplicação em produção: lock = NAO_COMMITADA; COMMIT 40003/sem resposta = INDETERMINADO; recusa = desfeita; a 108 não roda sem a 107 confirmada; código 2', async () => {
  for (const [rotulo, opcoes, commits] of [
    ['107 lock 55P03', {falharEm: comum.SQL_LOCK['107'], erro: erroPg('55P03')}, {107: 'NAO_COMMITADA'}],
    ['COMMIT 107 40003', {falharCommit: {n: 1, erro: erroPg('40003')}}, {107: 'INDETERMINADO'}],
    ['COMMIT 107 sem resposta', {falharCommit: {n: 1, erro: new Error('Connection terminated unexpectedly')}}, {107: 'INDETERMINADO'}],
    ['COMMIT 107 recusado', {falharCommit: {n: 1, erro: erroPg('23514')}}, {107: 'DESFEITA_PELO_SERVIDOR'}],
    ['108 lock 55P03', {falharEm: comum.SQL_LOCK['108'], erro: erroPg('55P03')}, {107: 'CONFIRMADO', 108: 'NAO_COMMITADA'}],
    ['COMMIT 108 40003', {falharCommit: {n: 2, erro: erroPg('40003')}}, {107: 'CONFIRMADO', 108: 'INDETERMINADO'}]]) {
    const dir = tmp();
    try {
      const C = clienteFalso(opcoes);
      const x = await prod.principal(APLICAR, ENV_PROD, {Client: C, dir, disco: semDisco});
      assert.equal(x.codigo, 2, rotulo + JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'FALHA', rotulo); assert.deepEqual(x.saida.commits, commits, rotulo);
      assert.match(x.saida.reconciliar, /--conferir-107-108/); assert.equal(x.saida.marcadorGravado, true);
      const m = JSON.parse(fs.readFileSync(x.saida.marcador, 'utf8'));
      assert.equal(m.situacao, 'FALHA'); assert.equal(m.ambiente, 'production'); assert.deepEqual(m.commits, commits, rotulo + ' (marcador)');
      if (!('108' in commits)) assert.ok(!C.log.some(l => l.sql === C108 || l.sql === comum.SQL_LOCK['108']), rotulo + ': 108 não roda');
      await assert.rejects(prod.principal(APLICAR, ENV_PROD, {Client: clienteFalso(), dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('plano de produção sem conexão: alvo e registro de produção, ordem de produção (PITR de production, drenagem, retrato divergente = parar); staging mantém a dele', async () => {
  const N = nuncaConecta();
  const {codigo, saida} = await prod.principal([], {}, {Client: N});
  assert.equal(codigo, 0); assert.equal(N.construido, false); assert.equal(saida.conecta, false); assert.equal(saida.ambiente, 'production');
  assert.deepEqual(saida.alvo, prod.ALVO); assert.equal(saida.registro, prod.DIR);
  assert.deepEqual(saida.ordem, [...prod.ORDEM]); assert.deepEqual(prod.plano().ordem, [...prod.ORDEM]);
  assert.ok(saida.ordem.findIndex(o => o.startsWith('--conferir-107-108 (mede F0')) < saida.ordem.findIndex(o => o.startsWith('--aplicar-107-108-autorizado')));
  assert.ok(saida.ordem.some(o => /PITR do PostgreSQL de production/.test(o) && /NÃO substitui/.test(o)));
  assert.ok(saida.ordem.some(o => /autorização de Felipe para a 107\/108 em production/.test(o)));
  assert.ok(saida.ordem.some(o => /drenada/.test(o) && /job\/shell do Render/.test(o) && /DDL/.test(o)) && saida.ordem.some(o => /imediatamente antes/.test(o)));
  assert.ok(saida.ordem.some(o => /RETRATO_F0_DIVERGENTE/.test(o) && /PARAR/.test(o) && /nunca vira referência/.test(o)));
  assert.ok(!saida.ordem.some(o => /staging|#267|098\//.test(o)), 'nada da ordem de staging');
  const s = (await stg.principal([], {})).saida;
  for (const k of ['arquivos', 'recuperacaoArquivos', 'retratos', 'modos', 'fases', 'transacoes', 'orcamento', 'preRequisitos', 'paradas', 'recuperacao', 'nuncaExecuta']) assert.deepEqual(saida[k], s[k], k);
  assert.ok(s.ordem.some(o => /PostgreSQL de staging/.test(o)), 'staging mantém a ordem dele');
  for (const n of ['down 107', 'down 108', 'ligar SALOES_PUBLICOS']) assert.ok(saida.nuncaExecuta.includes(n), n);
  assert.match(saida.modos.aplicar, /--drenagem/); assert.deepEqual(prod.CODIGO, stg.CODIGO);
});
