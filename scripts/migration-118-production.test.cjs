/* eslint-disable @typescript-eslint/no-require-imports */
// Adaptador de PRODUÇÃO da 118 com cliente simulado (sem rede nem banco): trava de alvo (serviço, ambiente, TLS
// obrigatório, host, banco, porta, URL sem query, variáveis do libpq, credencial sem controle), configuração EFETIVA do
// `pg` sem connectionString, identidade e papel (TLS ativo, rede privada, membro do papel, sem superusuário, dono de
// empresas e de ia_documentos), conferência e aplicação pelo núcleo comum com o marcador no disco de produção. O
// comportamento do núcleo (estado, preservação, situação do COMMIT, retomada) é provado em migration-118.test.cjs e no PG.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const comum = require('./migration-118-comum.cjs');
const {lerRevisado} = require('./migration-092-094-comum.cjs');
const prd = require('./migration-118-production.cjs');
const stg = require('./migration-118-staging.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_PRD = 'postgresql://usuario:SENHA_FALSA@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production';
const ENV_PRD = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'false', DATABASE_URL: URL_PRD, KIDMAIS_118_TLS_EXCECAO: 'D-118-TLS 2026-11-20 Felipe aceita servidor sem certificado verificado'});
const ID_PRD = Object.freeze({db: 'kidmais_production', tls: true, tls_versao: 'TLSv1.3', servidor_privado: true, papel_trocado: true, sessao_membro: true,
  papel_superusuario: false, sessao_superusuario: false, dono_empresas: true, dono_documentos: true,
  sessao_md5: require('node:crypto').createHash('md5').update('usuario').digest('hex'), dono_cotas: null, dono_usos: null, executa_periodo: null, executa_janela: null});
/** 118 já presente: o papel efetivo (o do web) é o dono das 2 tabelas e executa as 2 funções. */
const ID_PRD_118 = Object.freeze({...ID_PRD, dono_cotas: true, dono_usos: true, executa_periodo: true, executa_janela: true});
const BACKUP = 'PITR 2026-11-20T03:00Z painel-render';
/** Relógio do teste: 30 min depois do PITR anotado. */
const AGORA = Date.UTC(2026, 10, 20, 3, 30);
const ler = nome => { const [, a, h] = comum.ETAPAS.find(e => e[0] === nome); return lerRevisado(raiz, a, h); };
const C118 = comum.semCommitFinal(ler('migration 118'), 'm118');
const CHEIO = Object.freeze(Object.fromEntries(Object.entries(comum.OBJETOS).map(([k, v]) => [k, v.length])));
const VAZIO = Object.freeze(Object.fromEntries(Object.keys(comum.OBJETOS).map(k => [k, 0])));
const privilegios = {versao_pg: 180006, empresas: true, documentos: true, referencias_empresas: true, referencias_documentos: true,
  ler_empresas: true, ler_documentos: true, ler_cotas: true, ler_usos: true, usar_public: true, pode_criar: true, plpgsql: true, linguagem_sql: true,
  papel_trocado: true, indices_invalidos: []};
const ZERO = Object.freeze(Object.fromEntries(comum.PRESERVADAS.map(t => [t, 0])));

/** Cliente transacional mínimo: o corpo sem COMMIT deixa os 7 objetos pendentes; COMMIT confirma; ROLLBACK descarta. */
function clienteFalso({aplicada = false, identidade = aplicada ? ID_PRD_118 : ID_PRD} = {}) {
  const log = []; let pendente = null;
  const atual = {objetos: aplicada ? CHEIO : VAZIO};
  const C = class {
    constructor(opts) { C.opts = opts; }
    on() {} async connect() {} async end() {}
    async query(sql) {
      log.push(sql);
      if (sql === 'ROLLBACK') { pendente = null; return {rows: []}; }
      if (sql === 'COMMIT') { if (pendente) { atual.objetos = CHEIO; pendente = null; } return {rows: [], command: 'COMMIT'}; }
      if (sql === prd.SQL_IDENTIDADE) return {rows: [identidade]};
      if (sql === comum.SQL_USAGE_PUBLIC) return {rows: [{usar_public: true}]};
      if (sql === comum.SQL_ESTADO) return {rows: [{...privilegios, ...atual.objetos}]};
      if (sql === comum.SQL_DOCUMENTOS) return {rows: [{documentos: 40}]};
      if (sql === comum.SQL_NOVAS) return {rows: [{cotas: 0, reservadas: 0, consumidas: 0, liberadas: 0}]};
      if (sql === comum.SQL_PRESERVACAO) return {rows: [ZERO]};
      if (sql === comum.SQL_INDICES_INVALIDOS) return {rows: [{invalidos: []}]};
      if (sql === C118) pendente = true;
      return {rows: []};
    }
  };
  C.log = log; C.atual = atual;
  return C;
}

test('trava de alvo de produção: serviço, ambiente, TLS obrigatório, host, banco, porta, URL sem query; staging recusado; mensagem sem segredos', () => {
  const opts = prd.alvo(ENV_PRD);
  assert.equal(opts.application_name, 'kidmais-migration-118-production');
  assert.deepEqual(opts.ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'}, 'como a aplicação de produção');
  assert.deepEqual(prd.alvo({...ENV_PRD, DATABASE_SSL_REJECT_UNAUTHORIZED: undefined, KIDMAIS_118_TLS_EXCECAO: undefined}).ssl, {rejectUnauthorized: true, minVersion: 'TLSv1.2'});
  assert.ok(!('connectionString' in opts) && !JSON.stringify(opts).includes('SENHA_FALSA'));
  for (const [mudanca, erro] of [[{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}, /SERVICO_RECUSADO/],
    [{KIDMAIS_DEPLOY_ENV: 'staging'}, /AMBIENTE_RECUSADO/], [{DATABASE_SSL: 'false'}, /TLS_OBRIGATORIO/], [{DATABASE_SSL: undefined}, /TLS_OBRIGATORIO/],
    [{DATABASE_SSL_REJECT_UNAUTHORIZED: 'talvez'}, /TLS_CONFIGURACAO_RECUSADA/],
    [{DATABASE_URL: URL_PRD.replace('dpg-dak750gae00c73fudmg0-a', 'dpg-daidko3m8hqs73ce4jt0-a')}, /HOST_RECUSADO/],
    [{DATABASE_URL: URL_PRD.replace('dpg-dak750gae00c73fudmg0-a', 'dpg-dak750gae00c73fudmg0-a.oregon-postgres.render.com')}, /HOST_RECUSADO/],
    [{DATABASE_URL: URL_PRD.replace('kidmais_production', 'kidmais_staging_1z91')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_PRD.replace(':5432', ':5433')}, /PORTA_RECUSADA/], [{DATABASE_URL: URL_PRD + '?sslmode=disable'}, /CONNECTION_QUERY_REJECTED/],
    [{DATABASE_URL: URL_PRD + '?'}, /CONNECTION_QUERY_REJECTED/], [{DATABASE_URL: URL_PRD + '#'}, /CONNECTION_QUERY_REJECTED/],
    [{DATABASE_URL: 'nao-e-url'}, /URL_RECUSADA/], [{DATABASE_URL: URL_PRD.replace('postgresql:', 'http:')}, /URL_RECUSADA/],
    [{DATABASE_URL: undefined}, /CONNECTION_QUERY_REJECTED/], [{DATABASE_URL: URL_PRD.replace('usuario:SENHA_FALSA@', '')}, /CREDENCIAL_AUSENTE_NA_URL/],
    [{DATABASE_URL: URL_PRD.replace(':SENHA_FALSA@', '@')}, /CREDENCIAL_AUSENTE_NA_URL/],
    [{DATABASE_URL: URL_PRD.replace('usuario', 'usuario%00options%00-c%20x%3Dy')}, /^CREDENCIAL_COM_CONTROLE$/],
    [{DATABASE_URL: URL_PRD.replace('SENHA_FALSA', 'SENHA%7FFALSA')}, /^CREDENCIAL_COM_CONTROLE$/],
    ...prd.PG_HERDADAS_RECUSADAS.map(n => [{[n]: '-c search_path=outro'}, new RegExp('AMBIENTE_PG_RECUSADO ' + n)])]) {
    assert.throws(() => prd.alvo({...ENV_PRD, ...mudanca}), (e) => erro.test(e.message) && !e.message.includes('SENHA_FALSA'), JSON.stringify(mudanca));
  }
  assert.deepEqual(prd.PG_HERDADAS_RECUSADAS, stg.PG_HERDADAS_RECUSADAS, 'mesma lista do adaptador de staging (conferida contra o fonte do pg)');
  // Staging recusa o alvo de produção, e vice-versa: nenhum ambiente aceita o outro.
  assert.throws(() => stg.alvo({...ENV_PRD, DATABASE_SSL: 'false'}), /SERVICO_RECUSADO/);
  assert.equal(prd.DIR, '/opt/render/project/src/data/importacao-cotas-118-producao');
  assert.notEqual(prd.DIR, stg.DIR);
});

test('configuração EFETIVA do pg com variáveis libpq hostis herdadas: host, porta, banco, usuário, senha e TLS do alvo', () => {
  const ConnectionParameters = require('pg/lib/connection-parameters');
  const hostis = {PGPORT: '6543', PGHOST: 'dpg-outro', PGDATABASE: 'kidmais_staging_1z91', PGUSER: 'outro', PGPASSWORD: 'OUTRA', PGSSLMODE: 'disable',
    PGAPPNAME: 'outro', PGCONNECT_TIMEOUT: '999'};
  const guardado = Object.fromEntries(Object.keys(hostis).map(k => [k, process.env[k]]));
  Object.assign(process.env, hostis);
  try {
    const p = new ConnectionParameters(prd.alvo({...ENV_PRD, ...hostis, DATABASE_URL: URL_PRD.replace(':5432', '')}));
    assert.deepEqual({host: p.host, port: p.port, database: p.database, user: p.user, password: p.password, ssl: p.ssl, app: p.application_name},
      {host: 'dpg-dak750gae00c73fudmg0-a', port: 5432, database: 'kidmais_production', user: 'usuario', password: 'SENHA_FALSA',
        ssl: {rejectUnauthorized: false, minVersion: 'TLSv1.2'}, app: 'kidmais-migration-118-production'});
    assert.equal(p.options, undefined); assert.ok(!p.replication); assert.ok(!p.binary); assert.equal(p.connect_timeout, 10);
  } finally {
    for (const [k, v] of Object.entries(guardado)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('identidade e papel: banco, TLS ativo e versão, rede privada, membro do papel, sem superusuário, dono das 2 tabelas', () => {
  assert.deepEqual(prd.identidade(ID_PRD, ENV_PRD), {banco: 'kidmais_production', tls: true, tlsVersao: 'TLSv1.3', tlsVerificacao: ENV_PRD.KIDMAIS_118_TLS_EXCECAO,
    servidorPrivado: true, papelTrocado: true, papelDono: true,
    sessaoCredencialDoWeb: true, web118: 'ausente'});
  assert.equal(prd.identidade(ID_PRD_118, ENV_PRD).web118, 'dono');
  assert.equal(prd.identidade({...ID_PRD, papel_trocado: false, tls_versao: 'TLSv1.2'}, ENV_PRD).papelTrocado, false);
  for (const [mudanca, erro] of [[{db: 'kidmais_staging_1z91'}, 'BANCO_DIVERGENTE'], [{tls: false}, 'SEM_TLS'], [{tls: null}, 'SEM_TLS'],
    [{tls_versao: 'TLSv1.1'}, 'TLS_VERSAO_RECUSADA'], [{servidor_privado: false}, 'SERVIDOR_FORA_DA_REDE_PRIVADA'], [{papel_trocado: null}, 'PAPEL_ILEGIVEL'],
    [{sessao_membro: false}, 'SESSAO_FORA_DO_PAPEL'], [{papel_superusuario: true}, 'SUPERUSUARIO_RECUSADO'], [{sessao_superusuario: null}, 'SUPERUSUARIO_RECUSADO'],
    [{dono_empresas: false}, 'PAPEL_NAO_E_DONO_DA_APLICACAO'], [{dono_documentos: false}, 'PAPEL_NAO_E_DONO_DA_APLICACAO'],
    // Parecer r1 (P2): a sessão é a credencial do web, e a 118 já presente tem de ser escrevível pelo papel do web.
    [{sessao_md5: require('node:crypto').createHash('md5').update('outro_papel').digest('hex')}, 'SESSAO_NAO_E_A_CREDENCIAL_DO_WEB'],
    [{sessao_md5: undefined}, 'SESSAO_NAO_E_A_CREDENCIAL_DO_WEB'],
    [{...ID_PRD_118, dono_cotas: false}, 'WEB_SEM_ESCRITA_NA_118 dono_cotas'], [{...ID_PRD_118, dono_usos: false}, 'WEB_SEM_ESCRITA_NA_118 dono_usos'],
    [{...ID_PRD_118, executa_periodo: false}, 'WEB_SEM_ESCRITA_NA_118 executa_periodo'], [{...ID_PRD_118, executa_janela: false}, 'WEB_SEM_ESCRITA_NA_118 executa_janela'],
    [{dono_cotas: 'true'}, 'WEB_SEM_ESCRITA_NA_118 dono_cotas']]) {
    assert.throws(() => prd.identidade({...ID_PRD, ...mudanca}, ENV_PRD), (e) => new RegExp('^IDENTIDADE_RECUSADA ' + erro + '$').test(e.message), JSON.stringify(mudanca));
  }
  assert.throws(() => prd.identidade(undefined, ENV_PRD), (e) => e.message === 'IDENTIDADE_RECUSADA BANCO_DIVERGENTE');
  // A consulta só devolve booleanos, a versão do TLS e o nome do banco: nenhum nome de papel, host ou usuário.
  assert.match(prd.SQL_IDENTIDADE, /to_regclass\('public\.empresas'\)/); assert.match(prd.SQL_IDENTIDADE, /to_regclass\('public\.ia_documentos'\)/);
  assert.doesNotMatch(prd.SQL_IDENTIDADE, /AS (usuario|papel|host|role)\b/);
});

test('conferência pelo núcleo: identidade de produção na conexão; ausente = PRONTA_PARA_APLICAR; papel errado = FALHA sem ler o estado', async () => {
  const C = clienteFalso();
  const r = await prd.conferir({env: ENV_PRD, Client: C});
  assert.equal(r.resultado, 'PRONTA_PARA_APLICAR', JSON.stringify(r));
  assert.equal(C.opts.host, 'dpg-dak750gae00c73fudmg0-a'); assert.equal(C.log[0] === prd.SQL_IDENTIDADE || C.log.includes(prd.SQL_IDENTIDADE), true);
  assert.ok(!JSON.stringify(r).includes('SENHA_FALSA'));
  const aplicada = await prd.conferir({env: ENV_PRD, Client: clienteFalso({aplicada: true})});
  assert.equal(aplicada.resultado, 'JA_APLICADA_POSTCHECK_PASS', JSON.stringify(aplicada));
  const E = clienteFalso({identidade: {...ID_PRD, dono_documentos: false}});
  const errado = await prd.conferir({env: ENV_PRD, Client: E});
  assert.equal(errado.resultado, 'FALHA'); assert.match(errado.mensagem, /IDENTIDADE_RECUSADA PAPEL_NAO_E_DONO/);
  assert.ok(!E.log.includes(comum.SQL_ESTADO), 'estado não lido com identidade recusada');
  const codigo = await prd.principal(['--conferir-118'], ENV_PRD, {Client: clienteFalso()});
  assert.equal(codigo.codigo, 0);
});

test('aplicação pelo núcleo: marcador no diretório de produção, ambiente "production", backup registrado; segunda execução recusada', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r118p-'));
  try {
    const C = clienteFalso();
    const r = await prd.executar({env: ENV_PRD, backup: BACKUP, agora: AGORA, dir, Client: C, disco: () => {}});
    assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r));
    const m = JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8'));
    assert.equal(m.ambiente, 'production'); assert.equal(m.backup, BACKUP); assert.equal(m.situacao, 'CONCLUIDA');
    assert.ok(!fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8').includes('SENHA_FALSA'));
    await assert.rejects(prd.executar({env: ENV_PRD, backup: BACKUP, agora: AGORA, dir, Client: clienteFalso({aplicada: true}), disco: () => {}}), /TENTATIVA_ANTERIOR_REVISAR/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  // Recusas antes de escrever qualquer coisa no disco: alvo de staging e disco persistente ausente.
  const vazio = fs.mkdtempSync(path.join(os.tmpdir(), 'r118p-'));
  try {
    let criados = 0; const Espia = class { constructor() { criados++; } on() {} async connect() {} async query() { return {rows: []}; } async end() {} };
    await assert.rejects(prd.executar({env: {...ENV_PRD, RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}, backup: BACKUP, agora: AGORA, dir: vazio, Client: Espia, disco: () => {}}), /SERVICO_RECUSADO/);
    await assert.rejects(prd.executar({env: ENV_PRD, backup: BACKUP, agora: AGORA, dir: vazio, Client: Espia, disco: () => assert.fail('DISCO_PERSISTENTE_AUSENTE')}), /DISCO_PERSISTENTE_AUSENTE/);
    assert.equal(criados, 0); assert.deepEqual(fs.readdirSync(vazio), []);
  } finally { fs.rmSync(vazio, {recursive: true, force: true}); }
});

test('disco persistente: diretório de outro dispositivo e não symlink; senão DISCO_PERSISTENTE_AUSENTE', () => {
  const st = (dev, dir = true, link = false) => ({dev, isDirectory: () => dir, isSymbolicLink: () => link});
  prd.exigirDisco('/opt/render/project/src/data', p => (p.endsWith('/data') ? st(2) : st(1)));
  for (const stat of [p => (p.endsWith('/data') ? st(1) : st(1)), p => (p.endsWith('/data') ? st(2, true, true) : st(1)), p => (p.endsWith('/data') ? st(2, false) : st(1)),
    () => { throw Object.assign(new Error('x'), {code: 'ENOENT'}); }]) {
    assert.throws(() => prd.exigirDisco('/opt/render/project/src/data', stat), /DISCO_PERSISTENTE_AUSENTE/);
  }
});

test('plano sem conexão (ambiente production) e ordem de produção: PITR conferido contra o Shell, autorização, conferência funcional à parte', async () => {
  const p = await prd.principal([], {}, {});
  assert.equal(p.codigo, 0); assert.equal(p.saida.resultado, 'PLANO'); assert.equal(p.saida.ambiente, 'production'); assert.equal(p.saida.conecta, false);
  assert.deepEqual(p.saida.alvo, prd.ALVO); assert.equal(p.saida.registro, prd.DIR);
  const ordem = prd.ORDEM.join(' | ');
  assert.match(ordem, /autorização de Felipe para a 118 em produção/); assert.match(ordem, /PITR .*date -u/); assert.match(ordem, /--conferir-118 de novo, imediatamente antes/);
  assert.match(ordem, /CONTRACT_IMPORT ligado e autorização própria/);
  assert.ok(prd.ORDEM.indexOf('--aplicar-118-autorizado') > prd.ORDEM.findIndex(l => /^PITR/.test(l)), 'PITR antes de aplicar');
  await assert.rejects(prd.principal(['--aplicar-118-autorizado'], ENV_PRD, {}), /BACKUP_OBRIGATORIO/);
  // Parecer r1 (P2, plano): o PLANO de produção não exige a L2 publicada; exige a árvore com o aplicador e diz a janela da D-ESC-8.
  assert.ok(!p.saida.preRequisitos.some(r => /^código da L2/.test(r)), JSON.stringify(p.saida.preRequisitos));
  assert.ok(p.saida.preRequisitos.includes(prd.PRE_REQUISITO_ARVORE)); assert.match(prd.PRE_REQUISITO_ARVORE, /SEM a L2/); assert.match(prd.PRE_REQUISITO_ARVORE, /D-ESC-8/);
  assert.deepEqual(p.saida.ordemProducao, prd.ORDEM); assert.match(ordem, /lock_timeout.*FIM da transação/);
});

test('PITR também na CLI direta e no executar (parecer r1, P2/P3): data real, 0 a 120 min antes do relógio, referência com conteúdo; recusa antes do alvo, do disco e da conexão', async () => {
  assert.equal(prd.exigirBackup(BACKUP, AGORA), Date.UTC(2026, 10, 20, 3, 0));
  assert.equal(prd.exigirBackup(BACKUP, Date.UTC(2026, 10, 20, 3, 0)), Date.UTC(2026, 10, 20, 3, 0), 'limite inferior inclusivo (0)');
  assert.equal(prd.exigirBackup(BACKUP, Date.UTC(2026, 10, 20, 5, 0)), Date.UTC(2026, 10, 20, 3, 0), 'limite superior inclusivo (120 min)');
  const casos = [['backup manual de ontem', 'BACKUP_NAO_INFORMADO'], ['PITR 2020-01-01T00:00Z painel', 'BACKUP_FORA_DA_JANELA'],
    ['PITR 2026-02-30T25:00Z painel', 'BACKUP_HORARIO_ILEGIVEL'], ['PITR 2026-11-31T03:00Z painel', 'BACKUP_HORARIO_ILEGIVEL'],
    ['PITR 2026-11-20T03:00Z    ', 'BACKUP_NAO_INFORMADO'], ['PITR 2026-11-20T03:00Z ', 'BACKUP_NAO_INFORMADO'],
    ['PITR 2026-11-20T03:31Z painel', 'BACKUP_FORA_DA_JANELA'], ['PITR 2026-11-20T01:29Z painel', 'BACKUP_FORA_DA_JANELA'],
    ['PITR 2026-11-20T03:00Z painel'+String.fromCharCode(10)+'x', 'BACKUP_NAO_INFORMADO'], ['pitr 2026-11-20T03:00Z painel', 'BACKUP_NAO_INFORMADO']];
  for (const [b, erro] of casos) assert.throws(() => prd.exigirBackup(b, AGORA), (e) => e.message === erro, b);
  assert.throws(() => prd.exigirBackup(BACKUP, NaN), /BACKUP_FORA_DA_JANELA/);
  // Pela CLI direta e pelo executar: recusado antes de construir o cliente e de tocar o disco.
  const vazio = fs.mkdtempSync(path.join(os.tmpdir(), 'r118p-'));
  try {
    let criados = 0; const Espia = class { constructor() { criados++; } on() {} async connect() {} async query() { return {rows: []}; } async end() {} };
    let disco = 0;
    for (const [b, erro] of casos.filter(([b]) => /^[A-Za-z0-9:._/ -]{6,120}$/.test(b))) {
      await assert.rejects(prd.principal(['--aplicar-118-autorizado', '--backup', b], ENV_PRD, {Client: Espia, dir: vazio, disco: () => disco++, agora: AGORA}), (e) => e.message === erro, b);
      await assert.rejects(prd.executar({env: ENV_PRD, backup: b, dir: vazio, Client: Espia, disco: () => disco++, agora: AGORA}), (e) => e.message === erro, b);
    }
    // Sem relógio injetado vale o relógio real: um PITR de 2026-11-20 está fora da janela hoje.
    await assert.rejects(prd.executar({env: ENV_PRD, backup: 'PITR 2020-11-20T03:00Z painel', dir: vazio, Client: Espia, disco: () => disco++}), (e) => e.message === 'BACKUP_FORA_DA_JANELA');
    assert.equal(criados, 0); assert.equal(disco, 0); assert.deepEqual(fs.readdirSync(vazio), []);
  } finally { fs.rmSync(vazio, {recursive: true, force: true}); }
  // Válido pela CLI: segue para o núcleo (e chega ao Client).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r118p-'));
  try {
    const r = await prd.principal(['--aplicar-118-autorizado', '--backup', BACKUP], ENV_PRD, {Client: clienteFalso(), dir, disco: () => {}, agora: AGORA});
    assert.equal(r.codigo, 0, JSON.stringify(r)); assert.equal(r.saida.resultado, 'APLICADA_POSTCHECK_PASS');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('servidor autenticado (parecer r2, P2; rodada 4): canal ligado SCRAM-SHA-256-PLUS por padrão; CA confiável no handshake (com pin opcional) ou exceção explícita registrada', async () => {
  const crypto = require('node:crypto');
  const semExcecao = {...ENV_PRD, KIDMAIS_118_TLS_EXCECAO: undefined};
  // Padrão: canal ligado (o handshake não verifica o certificado autoassinado; a autenticação é a do SCRAM-PLUS).
  const padrao = prd.alvo(semExcecao);
  assert.deepEqual(padrao.ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'});
  assert.equal(padrao.enableChannelBinding, true);
  assert.equal(prd.modoTls(semExcecao).modo, prd.CANAL_LIGADO);
  assert.equal(prd.identidade(ID_PRD, semExcecao).tlsVerificacao, 'canal-ligado SCRAM-SHA-256-PLUS');
  assert.equal(prd.alvo(ENV_PRD).enableChannelBinding, undefined, 'só o canal ligado pede channel binding');
  for (const ruim of ['', 'D-118-TLS 2026-11-20 sim', 'D-118-TLS 2026-02-30 Felipe aceita servidor sem certificado verificado',
    'd-118-tls 2026-11-20 Felipe aceita servidor sem certificado verificado', ENV_PRD.KIDMAIS_118_TLS_EXCECAO + ' ', ENV_PRD.KIDMAIS_118_TLS_EXCECAO + String.fromCharCode(10)]) {
    assert.throws(() => prd.alvo({...semExcecao, KIDMAIS_118_TLS_EXCECAO: ruim}), (e) => e.message === 'TLS_EXCECAO_INVALIDA', JSON.stringify(ruim));
  }
  // Cliente que ignora a configuração (não liga o channel binding): recusado ao conectar, nenhuma consulta, nada no disco.
  const vazio = fs.mkdtempSync(path.join(os.tmpdir(), 'r118p-'));
  try {
    let consultas = 0, disco = 0;
    const Espia = class { on() {} async connect() {} async query(q) { if (q !== 'ROLLBACK') consultas++; return {rows: []}; } async end() {} };
    const c = await prd.principal(['--conferir-118'], semExcecao, {Client: Espia});
    assert.equal(c.codigo, 2); assert.equal(c.saida.resultado, 'FALHA'); assert.match(c.saida.mensagem, /CANAL_LIGADO_INDISPONIVEL/);
    const conf = await prd.conferir({env: semExcecao, Client: Espia});
    assert.match(conf.mensagem, /CANAL_LIGADO_INDISPONIVEL/);
    const ex = await prd.executar({env: semExcecao, backup: BACKUP, agora: AGORA, dir: vazio, Client: Espia, disco: () => disco++});
    assert.equal(ex.resultado, 'FALHA'); assert.equal(ex.falha.etapa, 'CONEXAO'); assert.match(ex.falha.mensagem, /CANAL_LIGADO_INDISPONIVEL/);
    assert.equal(consultas, 0, 'nenhuma consulta sem o canal ligado');
  } finally { fs.rmSync(vazio, {recursive: true, force: true}); }
  // Exceção registrada: segue sem verificar e fica na identidade (marcador e saída).
  assert.deepEqual(prd.alvo(ENV_PRD).ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r118p-'));
  try {
    const r = await prd.executar({env: ENV_PRD, backup: BACKUP, agora: AGORA, dir, Client: clienteFalso(), disco: () => {}});
    assert.equal(r.conexao.tlsVerificacao, ENV_PRD.KIDMAIS_118_TLS_EXCECAO);
    const m = JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8'));
    assert.equal(m.conexao.tlsVerificacao, ENV_PRD.KIDMAIS_118_TLS_EXCECAO, 'exceção registrada no marcador');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  // CA confiável: verificação no handshake, mesmo com DATABASE_SSL_REJECT_UNAUTHORIZED=false; exceção junto é recusada.
  // Certificado de TESTE (autoassinado, CN=kidmais-teste-118-ca, sem chave guardada): só para a CA ser um X.509 válido.
  const PEM = "-----BEGIN CERTIFICATE-----\nMIIBkzCCATmgAwIBAgIUWNkoT2qhHdo+lXDjO6cVLJg6euYwCgYIKoZIzj0EAwIw\nHzEdMBsGA1UEAwwUa2lkbWFpcy10ZXN0ZS0xMTgtY2EwHhcNMjYxMTA5MDMwOTEx\nWhcNMzYxMTA2MDMwOTExWjAfMR0wGwYDVQQDDBRraWRtYWlzLXRlc3RlLTExOC1j\nYTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABGGTglzVvLFwt6sJpeW9uQHsa/Aq\nJ3K5zwJaA1e8dfwJ0SV2ZyOUcSZIhdpvCR0MJlNgaTfx4UiPNuA5QPulBTqjUzBR\nMB0GA1UdDgQWBBQo05gfN+hovhHyZAVQsU/3fDBAWTAfBgNVHSMEGDAWgBQo05gf\nN+hovhHyZAVQsU/3fDBAWTAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gA\nMEUCIQDYMfKf2mHL+hiGfH/YBvFRMWZsGviFvNiZsyXC0oMqGQIgJPzuifC1rde+\ncVzsfA521GvW3qqcxGaZn2ytlilitn8=\n-----END CERTIFICATE-----\n";
  const CA = Buffer.from(PEM).toString('base64');
  const comCa = {...semExcecao, KIDMAIS_118_TLS_CA: CA};
  const s = prd.alvo(comCa).ssl;
  assert.equal(s.rejectUnauthorized, true); assert.equal(s.ca, PEM); assert.equal(s.checkServerIdentity, undefined);
  assert.equal(prd.identidade(ID_PRD, comCa).tlsVerificacao, 'ca');
  assert.throws(() => prd.alvo({...comCa, KIDMAIS_118_TLS_EXCECAO: ENV_PRD.KIDMAIS_118_TLS_EXCECAO}), (e) => e.message === 'TLS_CA_E_EXCECAO_JUNTAS');
  assert.throws(() => prd.alvo({...semExcecao, KIDMAIS_118_TLS_CA: Buffer.from('nao e pem').toString('base64')}), (e) => e.message === 'TLS_CA_INVALIDA');
  // Pin da folha: só com CA; comparado no handshake (checkServerIdentity).
  const folha = Buffer.from('certificado-der-de-teste'), pin = crypto.createHash('sha256').update(folha).digest('hex');
  const p = prd.alvo({...comCa, KIDMAIS_118_TLS_PIN: pin}).ssl;
  assert.equal(p.rejectUnauthorized, true); assert.equal(typeof p.checkServerIdentity, 'function');
  assert.equal(p.checkServerIdentity('dpg-dak750gae00c73fudmg0-a', {raw: folha}), undefined);
  assert.equal(p.checkServerIdentity('dpg-dak750gae00c73fudmg0-a', {raw: Buffer.from('outro')}).message, 'TLS_PIN_DIVERGENTE');
  assert.equal(p.checkServerIdentity('dpg-dak750gae00c73fudmg0-a', {}).message, 'TLS_PIN_ILEGIVEL');
  assert.equal(prd.identidade(ID_PRD, {...comCa, KIDMAIS_118_TLS_PIN: pin}).tlsVerificacao, 'ca+pin');
  assert.throws(() => prd.alvo({...semExcecao, KIDMAIS_118_TLS_PIN: pin}), (e) => e.message === 'TLS_PIN_SEM_CA');
  assert.throws(() => prd.alvo({...comCa, KIDMAIS_118_TLS_PIN: pin.toUpperCase()}), (e) => e.message === 'TLS_PIN_INVALIDO');
  // Sem REJECT=false (CA do sistema): exceção é desnecessária e recusada.
  assert.throws(() => prd.alvo({...ENV_PRD, DATABASE_SSL_REJECT_UNAUTHORIZED: 'true'}), (e) => e.message === 'TLS_EXCECAO_DESNECESSARIA');
  assert.equal(prd.identidade(ID_PRD, {...semExcecao, DATABASE_SSL_REJECT_UNAUTHORIZED: 'true'}).tlsVerificacao, 'ca-do-sistema');
});
