/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 079 em produção: trava de alvo, hashes, plano por estado do schema, anti-repetição e leitura sem escrita.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const m = require('./migration-079-production.cjs');

const URL_OK = 'postgresql://usuario:SENHA_FALSA@dpg-dak750gae00c73fudmg0-a/kidmais_production';
const ENV = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true', DATABASE_URL: URL_OK});
const ANTES = {m073: true, m074: true, m079: false, vestigio079: false, privilegio079: true};
const DEPOIS = {m073: true, m074: true, m079: true, vestigio079: true, privilegio079: true};

function clienteFalso({schemas = [ANTES, DEPOIS], db = 'kidmais_production', tls = true, falharEm} = {}) {
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
      if (sql.startsWith('SELECT current_database()')) return {rows: [{db, tls}]};
      if (sql.startsWith('SELECT to_regclass(\'public.convite_carteiras\')')) return {rows: [schemas[Math.min(i++, schemas.length - 1)]]};
      return {rows: []};
    },
  };
}

test('trava de alvo recusa outro serviço, ambiente, banco, host, TLS relaxado e parâmetros na URL', () => {
  assert.equal(m.alvo(ENV).ssl.rejectUnauthorized, true);
  const casos = [
    [{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}, /SERVICO_RECUSADO/],
    [{KIDMAIS_DEPLOY_ENV: 'staging'}, /AMBIENTE_RECUSADO/], [{DATABASE_SSL: 'false'}, /TLS_OBRIGATORIO/],
    [{DATABASE_SSL_REJECT_UNAUTHORIZED: 'false'}, /CERTIFICADO_SEM_VERIFICACAO/],
    [{DATABASE_URL: URL_OK.replace('kidmais_production', 'kidmais_staging_1z91')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_OK.replace('dpg-dak750gae00c73fudmg0-a', 'outro-host')}, /HOST_RECUSADO/],
    [{DATABASE_URL: URL_OK + '?sslmode=disable'}, /CONNECTION_QUERY_REJECTED/],
    [{DATABASE_URL: 'nao-e-url'}, /URL_RECUSADA/],
  ];
  for (const [delta, erro] of casos) assert.throws(() => m.alvo({...ENV, ...delta}), erro);
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

test('plano: 073/074 obrigatórias, vestígio parcial para, 079 completa só confere', () => {
  assert.deepEqual(m.planoEtapas(ANTES), ['precheck 079', 'migration 079', 'postcheck 079']);
  assert.deepEqual(m.planoEtapas(DEPOIS), ['postcheck 079']);
  assert.throws(() => m.planoEtapas({...ANTES, m074: false}), /DEPENDENCIA_AUSENTE/);
  assert.throws(() => m.planoEtapas({...ANTES, vestigio079: true}), /APLICACAO_PARCIAL_079/);
  assert.throws(() => m.planoEtapas({...ANTES, m079: null}), /SCHEMA_ILEGIVEL/);
  assert.throws(() => m.planoEtapas({...ANTES, privilegio079: false}), /SEM_PRIVILEGIO_DDL_079/);
  assert.deepEqual(m.planoEtapas({...DEPOIS, privilegio079: false}), ['postcheck 079']);
});

test('conferência roda só em transações READ ONLY e nunca executa a migration', async () => {
  const db = clienteFalso({schemas: [ANTES]});
  const r = await m.conferirNoCliente(db);
  assert.equal(r.resultado, 'PRONTA_PARA_APLICAR');
  assert.ok(!db.sqls.some(s => s.includes('ALTER TABLE')));
  assert.equal(db.sqls.filter(s => s === 'BEGIN TRANSACTION READ ONLY').length, 3);
  assert.ok(!db.sqls.some(s => s === 'BEGIN' || s === 'COMMIT'));
});

test('conferência recusa banco ou TLS divergentes antes de ler o schema', async () => {
  for (const opcoes of [{db: 'kidmais_staging_1z91'}, {tls: false}]) {
    const db = clienteFalso(opcoes);
    await assert.rejects(m.conferirNoCliente(db), /BANCO_DIVERGENTE|SEM_TLS/);
    assert.ok(!db.sqls.some(s => s.includes('convite_carteiras')));
  }
});

test('aplicação: precheck, migration e postcheck nessa ordem; já aplicada → só postcheck', async () => {
  const db = clienteFalso();
  const r = await m.aplicarNoCliente(db);
  assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS');
  assert.deepEqual(r.etapas.map(e => e.nome), ['precheck 079', 'migration 079', 'postcheck 079']);
  const iPre = db.sqls.findIndex(s => s.includes('079 precheck OK')), iMig = db.sqls.findIndex(s => s.includes('ADD COLUMN resolucao_resultado')),
    iPos = db.sqls.findIndex(s => s.includes('079 postcheck OK'));
  assert.ok(iPre >= 0 && iPre < iMig && iMig < iPos);
  const ja = clienteFalso({schemas: [DEPOIS, DEPOIS]});
  assert.equal((await m.aplicarNoCliente(ja)).resultado, 'JA_APLICADA_POSTCHECK_PASS');
  assert.ok(!ja.sqls.some(s => s.includes('ADD COLUMN')));
});

test('executar: marcador exclusivo impede segunda tentativa, inclusive depois de falha', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm079-'));
  try {
    const Falha = function () { return clienteFalso({falharEm: 'ADD COLUMN resolucao_resultado'}); };
    const r1 = await m.executar({env: ENV, dir, Client: Falha, disco: () => {}});
    assert.equal(r1.resultado, 'FALHA');
    const registro = JSON.parse(fs.readFileSync(path.join(dir, m.MARCADOR), 'utf8'));
    assert.equal(registro.situacao, 'FALHA');
    assert.ok(!JSON.stringify(registro).includes('SENHA_FALSA'));
    await assert.rejects(m.executar({env: ENV, dir, Client: function () { return clienteFalso(); }, disco: () => {}}), /TENTATIVA_ANTERIOR_REVISAR/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('sem privilégio de DDL: conferência recusa e aplicação não executa a migration', async () => {
  const semDdl = {...ANTES, privilegio079: false};
  await assert.rejects(m.conferirNoCliente(clienteFalso({schemas: [semDdl]})), /SEM_PRIVILEGIO_DDL_079/);
  const db = clienteFalso({schemas: [semDdl]});
  await assert.rejects(m.aplicarNoCliente(db), /SEM_PRIVILEGIO_DDL_079/);
  assert.ok(!db.sqls.some(q => q.includes('ALTER TABLE') || q.includes('079 precheck OK')));
});

test('executar exige disco persistente antes de gravar o marcador', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm079-'));
  try {
    await assert.rejects(m.executar({env: ENV, dir, Client: function () { return clienteFalso(); }, disco: () => m.exigirDisco(dir)}), /DISCO_PERSISTENTE_AUSENTE/);
    assert.equal(fs.existsSync(path.join(dir, m.MARCADOR)), false);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
