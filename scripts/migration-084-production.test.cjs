/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 084 em produção: trava de alvo, hashes, plano por estado do schema, estados preservados, anti-repetição e
// leitura sem escrita. Mesmo formato do teste revisado do aplicador da 079.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const m = require('./migration-084-production.cjs');

const URL_OK = 'postgresql://usuario:SENHA_FALSA@dpg-dak750gae00c73fudmg0-a/kidmais_production';
const ENV = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true', DATABASE_URL: URL_OK});
const ESTADOS = {INCERTA: 1, CONCLUIDA: 3};
const ANTES = {m073: true, m079: true, m084: false, vestigio084: false, privilegio084: true, estados: ESTADOS};
const DEPOIS = {m073: true, m079: true, m084: true, vestigio084: true, privilegio084: true, estados: ESTADOS};

function clienteFalso({schemas = [ANTES, DEPOIS], db = 'kidmais_production', tls = true, tlsVersao = 'TLSv1.3', privado = true, falharEm} = {}) {
  const sqls = [];
  let i = 0;
  return {
    sqls,
    on() {},
    async connect() {},
    async end() {},
    async query(sql) {
      sqls.push(sql);
      if (falharEm && sql.includes(falharEm)) throw new Error('falha simulada');
      if (sql.startsWith('SELECT current_database()')) return {rows: [{db, tls, tls_versao: tlsVersao, servidor_privado: privado}]};
      if (sql.startsWith('SELECT to_regclass(\'public.convite_geracoes\')')) return {rows: [schemas[Math.min(i++, schemas.length - 1)]]};
      return {rows: []};
    },
  };
}

test('trava de alvo recusa outro serviço, ambiente, banco, host, TLS desligado e parâmetros na URL', () => {
  assert.deepEqual(m.alvo(ENV).ssl, {rejectUnauthorized: true, minVersion: 'TLSv1.2'});
  // Como o serviço (lib/db/postgres.ts e P0): sem verificação do certificado só quando o env do serviço manda; TLS continua obrigatório.
  assert.deepEqual(m.alvo({...ENV, DATABASE_SSL_REJECT_UNAUTHORIZED: 'false'}).ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'});
  const casos = [
    [{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}, /SERVICO_RECUSADO/],
    [{KIDMAIS_DEPLOY_ENV: 'staging'}, /AMBIENTE_RECUSADO/], [{DATABASE_SSL: 'false'}, /TLS_OBRIGATORIO/],
    [{DATABASE_SSL: 'false', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false'}, /TLS_OBRIGATORIO/],
    [{DATABASE_URL: URL_OK.replace('dpg-dak750gae00c73fudmg0-a', 'dpg-dak750gae00c73fudmg0-a.virginia-postgres.render.com')}, /HOST_RECUSADO/],
    [{DATABASE_URL: URL_OK.replace('kidmais_production', 'kidmais_staging_1z91')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_OK.replace('dpg-dak750gae00c73fudmg0-a', 'outro-host')}, /HOST_RECUSADO/],
    [{DATABASE_URL: URL_OK + '?sslmode=disable'}, /CONNECTION_QUERY_REJECTED/],
    [{DATABASE_URL: 'nao-e-url'}, /URL_RECUSADA/],
  ];
  for (const [delta, erro] of casos) assert.throws(() => m.alvo({...ENV, ...delta}), erro);
});

test('mensagens da trava são só o código: nunca ecoam URL, query, host ou variáveis', () => {
  const casos = [{DATABASE_URL: URL_OK + '?password=SEGREDO_NA_QUERY'}, {DATABASE_URL: URL_OK.replace('dpg-dak750gae00c73fudmg0-a', 'host-SEGREDO')}, {RENDER_SERVICE_ID: 'srv-SEGREDO'}];
  for (const delta of casos) {
    let msg = '';
    try { m.alvo({...ENV, ...delta}); } catch (e) { msg = String(e.message); }
    assert.match(msg, /^[A-Z_]+$/); assert.ok(!msg.includes('SEGREDO') && !msg.includes('SENHA_FALSA'));
  }
});

test('conferir() com o TLS do serviço (certificado não verificado) informa isso na saída e não grava nada', async () => {
  const env = {...ENV, DATABASE_SSL_REJECT_UNAUTHORIZED: 'false'};
  let opcoes = null;
  const Client = function (o) { opcoes = o; return clienteFalso({schemas: [ANTES]}); };
  const r = await m.conferir({env, Client});
  assert.equal(r.resultado, 'PRONTA_PARA_APLICAR');
  assert.deepEqual(opcoes.ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'});
  assert.deepEqual(r.conexao, {banco: 'kidmais_production', tls: true, tlsVersao: 'TLSv1.3', servidorPrivado: true, certificadoVerificado: false});
  assert.ok(!JSON.stringify(r).includes('SENHA_FALSA'));
});

test('flags: exatamente uma, sem mistura entre conferência e aplicação', () => {
  assert.ok(m.autorizado([m.FLAG])); assert.ok(m.conferencia([m.FLAG_CONFERIR]));
  assert.ok(!m.autorizado([m.FLAG, m.FLAG_CONFERIR])); assert.ok(!m.autorizado(['--aplicar'])); assert.ok(!m.conferencia([m.FLAG]));
});

test('arquivos revisados batem com os hashes fixados (CRLF normalizado)', () => {
  const raiz = path.resolve(__dirname, '..');
  for (const [, arquivo, hash] of m.ETAPAS) assert.ok(m.lerRevisado(raiz, arquivo, hash).length > 100);
  assert.throws(() => m.lerRevisado(raiz, m.ETAPAS[0][1], '0'.repeat(64)), /ARQUIVO_DIVERGENTE/);
});

test('plano: 073/079 obrigatórias, vestígio parcial para, 084 completa só confere', () => {
  assert.deepEqual(m.planoEtapas(ANTES), ['precheck 084', 'migration 084', 'postcheck 084']);
  assert.deepEqual(m.planoEtapas(DEPOIS), ['postcheck 084']);
  assert.throws(() => m.planoEtapas({...ANTES, m079: false}), /DEPENDENCIA_AUSENTE/);
  assert.throws(() => m.planoEtapas({...ANTES, vestigio084: true}), /APLICACAO_PARCIAL_084/);
  assert.throws(() => m.planoEtapas({...ANTES, m084: null}), /SCHEMA_ILEGIVEL/);
  assert.throws(() => m.planoEtapas({...ANTES, privilegio084: false}), /SEM_PRIVILEGIO_DDL_084/);
  assert.deepEqual(m.planoEtapas({...DEPOIS, privilegio084: false}), ['postcheck 084']);
});

test('conferência roda só em transações READ ONLY e nunca executa a migration', async () => {
  const db = clienteFalso({schemas: [ANTES]});
  const r = await m.conferirNoCliente(db);
  assert.equal(r.resultado, 'PRONTA_PARA_APLICAR');
  assert.ok(!db.sqls.some(s => s.includes('ALTER TABLE')));
  assert.equal(db.sqls.filter(s => s === 'BEGIN TRANSACTION READ ONLY').length, 3);
  assert.ok(!db.sqls.some(s => s === 'BEGIN' || s === 'COMMIT'));
});

test('conferência recusa banco, TLS ausente, TLS antigo ou servidor fora da rede privada antes de ler o schema', async () => {
  for (const [opcoes, erro] of [[{db: 'kidmais_staging_1z91'}, /BANCO_DIVERGENTE/], [{tls: false}, /SEM_TLS/], [{tls: null}, /SEM_TLS/],
    [{tlsVersao: 'TLSv1.1'}, /TLS_VERSAO_RECUSADA/], [{tlsVersao: null}, /TLS_VERSAO_RECUSADA/], [{privado: false}, /SERVIDOR_FORA_DA_REDE_PRIVADA/]]) {
    const db = clienteFalso(opcoes);
    await assert.rejects(m.conferirNoCliente(db), erro);
    assert.ok(!db.sqls.some(s => s.includes('convite_geracoes_etapas_consistentes')));
  }
});

test('aplicação: precheck, migration e postcheck nessa ordem; já aplicada → só postcheck', async () => {
  const db = clienteFalso();
  const r = await m.aplicarNoCliente(db);
  assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS');
  assert.deepEqual(r.etapas.map(e => e.nome), ['precheck 084', 'migration 084', 'postcheck 084']);
  const iPre = db.sqls.findIndex(s => s.includes('084 precheck OK')), iMig = db.sqls.findIndex(s => s.includes('ADD COLUMN etapas_registradas')),
    iPos = db.sqls.findIndex(s => s.includes('084 postcheck OK'));
  assert.ok(iPre >= 0 && iPre < iMig && iMig < iPos);
  const ja = clienteFalso({schemas: [DEPOIS, DEPOIS]});
  assert.equal((await m.aplicarNoCliente(ja)).resultado, 'JA_APLICADA_POSTCHECK_PASS');
  assert.ok(!ja.sqls.some(s => s.includes('ADD COLUMN')));
});

test('executar: marcador exclusivo impede segunda tentativa, inclusive depois de falha', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm084-'));
  try {
    const Falha = function () { return clienteFalso({falharEm: 'ADD COLUMN etapas_registradas'}); };
    const r1 = await m.executar({env: ENV, dir, Client: Falha, disco: () => {}});
    assert.equal(r1.resultado, 'FALHA');
    const registro = JSON.parse(fs.readFileSync(path.join(dir, m.MARCADOR), 'utf8'));
    assert.equal(registro.situacao, 'FALHA');
    assert.ok(!JSON.stringify(registro).includes('SENHA_FALSA'));
    await assert.rejects(m.executar({env: ENV, dir, Client: function () { return clienteFalso(); }, disco: () => {}}), /TENTATIVA_ANTERIOR_REVISAR/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('sem privilégio de DDL: conferência recusa e aplicação não executa a migration', async () => {
  const semDdl = {...ANTES, privilegio084: false};
  await assert.rejects(m.conferirNoCliente(clienteFalso({schemas: [semDdl]})), /SEM_PRIVILEGIO_DDL_084/);
  const db = clienteFalso({schemas: [semDdl]});
  await assert.rejects(m.aplicarNoCliente(db), /SEM_PRIVILEGIO_DDL_084/);
  assert.ok(!db.sqls.some(q => q.includes('ALTER TABLE') || q.includes('084 precheck OK')));
});

test('executar exige disco persistente antes de gravar o marcador', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm084-'));
  try {
    await assert.rejects(m.executar({env: ENV, dir, Client: function () { return clienteFalso(); }, disco: () => m.exigirDisco(dir)}), /DISCO_PERSISTENTE_AUSENTE/);
    assert.equal(fs.existsSync(path.join(dir, m.MARCADOR)), false);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('estados por geração são informativos: mudança concorrente do app não vira FALHA de uma DDL já confirmada', async () => {
  const mudou = clienteFalso({schemas: [ANTES, {...DEPOIS, estados: {INCERTA: 1, CONCLUIDA: 4}}]});
  const r1 = await m.aplicarNoCliente(mudou);
  assert.equal(r1.resultado, 'APLICADA_POSTCHECK_PASS'); assert.equal(r1.estadosIguais, false);
  const r2 = await m.aplicarNoCliente(clienteFalso());
  assert.equal(r2.estadosIguais, true); assert.deepEqual(r2.schemaDepois.estados, r2.schemaAntes.estados);
});

test('executar: falha depois da migration preserva no marcador as etapas já concluídas (não apaga a evidência)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm084-'));
  try {
    const Falha = function () { return clienteFalso({falharEm: '084 postcheck OK'}); };
    const r = await m.executar({env: ENV, dir, Client: Falha, disco: () => {}});
    assert.equal(r.resultado, 'FALHA');
    const registro = JSON.parse(fs.readFileSync(path.join(dir, m.MARCADOR), 'utf8'));
    assert.equal(registro.situacao, 'FALHA');
    assert.deepEqual(registro.etapas.map(e => [e.nome, e.ok ?? false]), [['precheck 084', true], ['migration 084', true], ['postcheck 084', false]]);
    assert.deepEqual(registro.schemaAntes.estados, ESTADOS);
    assert.ok(!JSON.stringify(registro).includes('SENHA_FALSA'));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('executar concluído grava CONCLUIDA com estadosIguais e as etapas no marcador', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm084-'));
  try {
    const r = await m.executar({env: ENV, dir, Client: function () { return clienteFalso(); }, disco: () => {}});
    assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS'); assert.equal(r.estadosIguais, true);
    const registro = JSON.parse(fs.readFileSync(path.join(dir, m.MARCADOR), 'utf8'));
    assert.equal(registro.situacao, 'CONCLUIDA'); assert.equal(registro.etapas.length, 3);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('alvo e marcador são exclusivos da 084 em produção (não reaproveita o marcador nem a pasta da 079)', () => {
  assert.equal(m.MARCADOR, 'migration-084.json');
  assert.ok(m.DIR.endsWith('convites-geracao-pendente-producao-20261018'));
  assert.deepEqual(m.ETAPAS.map(e => e[0]), ['precheck 084', 'migration 084', 'postcheck 084']);
  assert.ok(m.SQL_SCHEMA.includes('etapas_registradas') && m.SQL_SCHEMA.includes('estados'));
});
