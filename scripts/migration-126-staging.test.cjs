/* eslint-disable @typescript-eslint/no-require-imports */
// Adaptador de STAGING da 126 (scripts/migration-126-staging.cjs) com cliente simulado que só CONFIRMA no COMMIT: alvo só
// staging (production e outro banco recusados antes de conectar), identidade de staging lida no servidor, conferência só
// leitura, preflight antes do marcador, UMA transação precheck → corpo → postcheck → COMMIT, marcador exclusivo, replay
// recusado e códigos 0/1/2/3. O núcleo (hashes, sentinelas, privilégios, situação do COMMIT) é coberto pelo teste do genérico.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const s = require('./migration-126-staging.cjs');
const g = require('./migration-generico-production.cjs');
const stg = require('./conexao-staging.cjs');

const raiz = path.resolve(__dirname, '..');
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false',
  DATABASE_URL: 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'});
const ENV_PROD = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_URL: 'postgresql://usuario:SENHA_FALSA@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production'});
const ID_STG = Object.freeze({db: 'kidmais_staging_1z91', tls: false, servidor_privado: true});
const BACKUP = 'export staging 2026-11-14T20:00Z';
const PRIV_OK = Object.freeze({schema_create: true, sem_posse: [], sem_references: [], sem_posse_funcoes: [], sem_execute: [], sem_lock: [], sem_select: []});
const linha = v => Object.fromEntries(g.MIGRATIONS['126'].criados.map((_, i) => ['c' + i, v]));

function clienteFalso({situacao = 'ausente', identidade = ID_STG, falharEm} = {}) {
  const corpos = g.carregar(raiz, '126');
  const log = []; let ro = false, emTransacao = false, pendente = false, conexoes = 0;
  const atual = {linha: linha(situacao === 'presente')};
  const C = class {
    on() {} async connect() { conexoes++; } async end() {}
    async query(sql) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') ro = true;
      if (sql === 'BEGIN') emTransacao = true;
      log.push({sql, ro, emTransacao});
      if (falharEm && sql.includes(falharEm)) throw Object.assign(new Error('falha simulada'), {code: 'P0001'});
      if (sql === 'ROLLBACK') { ro = false; emTransacao = false; pendente = false; return {rows: [], command: 'ROLLBACK'}; }
      if (sql === 'COMMIT') { if (pendente) atual.linha = linha(true); emTransacao = false; pendente = false; return {rows: [], command: 'COMMIT'}; }
      if (sql === stg.SQL_IDENTIDADE) return {rows: [identidade]};
      if (sql === g.sqlEstado('126')) return {rows: [{...atual.linha}]};
      if (sql === g.sqlPrivilegios('126')) return {rows: [{...PRIV_OK}]};
      if (sql === corpos.migration) { assert.ok(emTransacao && !ro, 'migration só na transação de escrita'); pendente = true; return [{rows: [], command: 'CREATE'}]; }
      if (sql === corpos.precheck || sql === corpos.postcheck) return [{rows: [], command: 'DO'}, {rows: [{aprovado: true}], command: 'SELECT'}];
      return {rows: [], command: 'SET'};
    }
  };
  C.log = log; C.atual = atual; C.conexoes = () => conexoes;
  return C;
}
// Cada pasta temporária é removida no t.after() do próprio teste, mesmo se uma asserção falhar.
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mig126-stg-')); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; };
const semDisco = () => {};

test('plano: staging, só a 126, hashes do genérico, sem conexão', async () => {
  const {codigo, saida} = await s.principal([], {});
  assert.equal(codigo, 0);
  assert.equal(saida.ambiente, 'staging');
  assert.equal(saida.id, '126');
  assert.deepEqual(saida.arquivos.map(a => a.sha256), g.MIGRATIONS['126'].arquivos.map(a => a[2]));
  assert.ok(saida.nuncaExecuta.includes('production'));
});

test('argumentos: só --conferir-126 e --aplicar-126-autorizado com backup; outra migration recusada', () => {
  assert.deepEqual(s.modo(['--conferir-126']), {modo: 'conferir'});
  assert.deepEqual(s.modo(['--aplicar-126-autorizado', '--backup', BACKUP]), {modo: 'aplicar', backup: BACKUP});
  assert.throws(() => s.modo(['--aplicar-126-autorizado']), /BACKUP_OBRIGATORIO/);
  assert.throws(() => s.modo(['--conferir', '120']), /ARGUMENTOS_RECUSADOS/);
  assert.throws(() => s.modo(['--aplicar-126-autorizado', '--backup', 'x;rm']), /BACKUP_INVALIDO/);
});

test('alvo: production, outro serviço, outro banco e fora do Render recusados antes de conectar', async t => {
  assert.equal(s.alvo(ENV_STG).application_name, 'kidmais-migration-126-staging');
  assert.equal(s.alvo(ENV_STG).database, 'kidmais_staging_1z91');
  assert.ok(!JSON.stringify(s.alvo(ENV_STG)).includes('SENHA_FALSA'));
  assert.throws(() => s.alvo(ENV_PROD), /SERVICO_RECUSADO/);
  assert.throws(() => s.alvo({...ENV_STG, RENDER: undefined}), /FORA_DO_RENDER/);
  assert.throws(() => s.alvo({...ENV_STG, DATABASE_URL: ENV_STG.DATABASE_URL.replace('kidmais_staging_1z91', 'kidmais_production')}), /BANCO_RECUSADO/);
  const C = clienteFalso();
  await assert.rejects(s.principal(['--aplicar-126-autorizado', '--backup', BACKUP], ENV_PROD, {Client: C, dir: tmp(t), disco: semDisco}), /SERVICO_RECUSADO/);
  assert.equal(C.conexoes(), 0);
});

test('conferir: só leitura; ausente → PRONTA_PARA_APLICAR; identidade de outro banco → FALHA', async () => {
  const C = clienteFalso();
  const r = await s.principal(['--conferir-126'], ENV_STG, {Client: C});
  assert.equal(r.saida.resultado, 'PRONTA_PARA_APLICAR');
  assert.equal(r.codigo, 0);
  assert.ok(!C.log.some(x => x.sql === 'BEGIN' || x.sql === 'COMMIT'));
  const outro = await s.principal(['--conferir-126'], ENV_STG, {Client: clienteFalso({identidade: {...ID_STG, db: 'kidmais_production'}})});
  assert.equal(outro.saida.resultado, 'FALHA');
  assert.equal(outro.codigo, 2);
});

test('aplicar: uma transação, COMMIT, postcheck; marcador exclusivo; replay recusado; depois JA_APLICADA', async t => {
  const dir = tmp(t);
  const C = clienteFalso();
  const r = await s.principal(['--aplicar-126-autorizado', '--backup', BACKUP], ENV_STG, {Client: C, dir, disco: semDisco});
  assert.equal(r.saida.resultado, 'APLICADA_POSTCHECK_PASS');
  assert.equal(r.codigo, 0);
  assert.deepEqual(r.saida.commitadas, ['126']);
  assert.equal(C.log.filter(x => x.sql === 'COMMIT').length, 1);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'migration-126.json'), 'utf8'));
  assert.equal(m.ambiente, 'staging');
  assert.equal(m.situacao, 'CONCLUIDA');
  await assert.rejects(s.principal(['--aplicar-126-autorizado', '--backup', BACKUP], ENV_STG, {Client: C, dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
  assert.equal((await s.principal(['--conferir-126'], ENV_STG, {Client: C})).saida.resultado, 'JA_APLICADA_POSTCHECK_PASS');
});

test('aplicar: preflight recusado (precheck falha) não grava marcador; falha no postcheck = FALHA NAO_COMMITADA', async t => {
  const corpos = g.carregar(raiz, '126');
  const dir = tmp(t);
  await assert.rejects(s.principal(['--aplicar-126-autorizado', '--backup', BACKUP], ENV_STG,
    {Client: clienteFalso({falharEm: corpos.precheck.slice(0, 200)}), dir, disco: semDisco}), /PREFLIGHT_RECUSOU/);
  assert.deepEqual(fs.readdirSync(dir), []);
  const dir2 = tmp(t);
  const C = clienteFalso({falharEm: corpos.postcheck.slice(0, 200)});
  // O postcheck não roda na conferência do preflight (estado ausente → só precheck), só dentro da transação.
  const r = await s.principal(['--aplicar-126-autorizado', '--backup', BACKUP], ENV_STG, {Client: C, dir: dir2, disco: semDisco});
  assert.equal(r.saida.resultado, 'FALHA');
  assert.equal(r.codigo, 2);
  assert.deepEqual(r.saida.commits, {126: 'NAO_COMMITADA'});
  assert.equal(C.log.filter(x => x.sql === 'COMMIT').length, 0);
});

test('disco persistente ausente recusa antes de conectar', async t => {
  const C = clienteFalso();
  await assert.rejects(s.principal(['--aplicar-126-autorizado', '--backup', BACKUP], ENV_STG,
    {Client: C, dir: tmp(t), disco: () => assert.fail('DISCO_PERSISTENTE_AUSENTE')}), /DISCO_PERSISTENTE_AUSENTE/);
  assert.equal(C.conexoes(), 0);
});

test('executar chamado direto sem backup válido recusa antes de conectar e não grava marcador', async t => {
  const C = clienteFalso();
  for (const backup of [undefined, '', 'x;rm']) {
    const dir = tmp(t);
    await assert.rejects(s.executar({env: ENV_STG, backup, dir, Client: C, disco: semDisco}), /BACKUP_OBRIGATORIO/);
    assert.deepEqual(fs.readdirSync(dir), []);
  }
  assert.equal(C.conexoes(), 0);
});
